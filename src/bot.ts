/**
 * Durable Object — «мозг» бота: база (SQLite), сценарий диалога и очередь долгих задач.
 * Долгие задачи (нейросети) выполняются в alarm(): там нет ограничения в 10 мс процессора
 * и можно ждать ответа нейросети несколько минут.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { hasClaude, hasImages, isAutoload, setting } from "./env";
import { APPAREL, CATEGORY, CONDITIONS, EDITABLE, GOODS_TYPES, Listing, MAX_IMAGES, TITLE_MAX } from "./fields";
import { Img, makeListing, rewriteField } from "./ai";
import { cutoutIntoStudio, generateImage } from "./images";
import { Avito, buildFeed, describeStatus, fullDescription } from "./avito";
import { Telegram, TgCallback, TgMessage, TgUpdate } from "./telegram";
import * as K from "./keyboards";
import { detectMime, esc, formatPrice, newId } from "./util";

type Row = Record<string, unknown>;

const ST = {
  DRAFT: "draft",
  QUEUED: "queued",
  UPLOADING: "uploading",
  PUBLISHED: "published",
  MANUAL: "manual",
  ERROR: "error",
  REMOVED: "removed",
} as const;

const STYLE_NAMES: Record<string, string> = {
  cutout: "вещь вырезана и поставлена в студию",
  ai_studio: "нейросеть: вещь в студии",
  ai_model: "нейросеть: вещь на модели",
  original: "ваши фото без обработки",
};

const MAX_FILE = 1_900_000; // ограничение строки в базе Durable Object — 2 МБ
const MAX_SRC_PHOTOS = 8;
const UPLOAD_INTERVAL = 3600_000; // Авито: запуск загрузки не чаще раза в час

interface Item {
  id: string;
  user_id: number;
  chat_id: number;
  status: string;
  studio_id: number | null;
  user_text: string;
  listing: Listing | null;
  photo_style: string | null;
  photo_variant: number;
  photos: string[];
  busy: number;
  avito_url: string | null;
  last_error: string | null;
  updated_at: number;
}

interface Session {
  user_id: number;
  chat_id: number;
  state: string;
  item_id: string | null;
  field: string | null;
  relocate: number;
}

interface Job {
  id: number;
  type: string;
  item_id: string;
  chat_id: number;
  data: { field?: string; wish?: string; waitId?: number };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, added_at INTEGER);
CREATE TABLE IF NOT EXISTS studios (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, media_id TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, item_id TEXT, kind TEXT, mime TEXT, data BLOB, created_at INTEGER);
CREATE INDEX IF NOT EXISTS media_item ON media (item_id, kind);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY, user_id INTEGER, chat_id INTEGER, status TEXT, studio_id INTEGER,
  user_text TEXT DEFAULT '', listing TEXT, photo_style TEXT, photo_variant INTEGER DEFAULT 0,
  photos TEXT DEFAULT '[]', busy INTEGER DEFAULT 0, avito_id INTEGER, avito_url TEXT, last_error TEXT,
  created_at INTEGER, updated_at INTEGER, published_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  user_id INTEGER PRIMARY KEY, chat_id INTEGER, state TEXT, item_id TEXT, field TEXT, relocate INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT, item_id TEXT, chat_id INTEGER, data TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS seen_groups (id TEXT PRIMARY KEY, created_at INTEGER);
`;

export class BotDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private tg: Telegram;
  private avito?: Avito;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) this.sql.exec(stmt);
  }

  // ---------------------------------------------------------------- база

  private q(query: string, ...binds: unknown[]): Row[] {
    return this.sql.exec(query, ...(binds as SqlStorageValue[])).toArray() as Row[];
  }

  private kvGet(key: string, fallback = ""): string {
    const row = this.q("SELECT value FROM kv WHERE key = ?", key)[0];
    return row ? String(row.value) : fallback;
  }

  private kvSet(key: string, value: string): void {
    this.q("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  private secret(): string {
    let s = this.kvGet("media_secret");
    if (!s) {
      s = newId("s") + newId("");
      this.kvSet("media_secret", s);
    }
    return s;
  }

  private origin(): string {
    return this.kvGet("origin");
  }

  private item(id: string | null | undefined): Item | null {
    if (!id) return null;
    const r = this.q("SELECT * FROM items WHERE id = ?", id)[0];
    if (!r) return null;
    return {
      ...(r as unknown as Item),
      listing: r.listing ? (JSON.parse(String(r.listing)) as Listing) : null,
      photos: JSON.parse(String(r.photos || "[]")) as string[],
    };
  }

  private updateItem(id: string, fields: Partial<Record<keyof Item | "avito_id" | "published_at", unknown>>): void {
    const entries = Object.entries(fields).map(([k, v]) =>
      [k, k === "listing" || k === "photos" ? JSON.stringify(v) : v] as [string, unknown],
    );
    entries.push(["updated_at", Date.now()]);
    this.q(`UPDATE items SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`, ...entries.map(([, v]) => v), id);
  }

  private session(userId: number, chatId: number): Session {
    const r = this.q("SELECT * FROM sessions WHERE user_id = ?", userId)[0];
    if (r) return r as unknown as Session;
    return { user_id: userId, chat_id: chatId, state: "idle", item_id: null, field: null, relocate: 0 };
  }

  /** Меняет сессию на месте (s обновляется), чтобы последовательные правки не затирали друг друга. */
  private setSession(s: Session, patch: Partial<Session>): Session {
    const next = Object.assign(s, patch);
    this.q(
      `INSERT INTO sessions (user_id, chat_id, state, item_id, field, relocate) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id, state = excluded.state, item_id = excluded.item_id,
       field = excluded.field, relocate = excluded.relocate`,
      next.user_id, next.chat_id, next.state, next.item_id, next.field, next.relocate,
    );
    return next;
  }

  private saveMedia(itemId: string | null, kind: string, data: ArrayBuffer, mime: string): string {
    const id = newId("m");
    this.q("INSERT INTO media (id, item_id, kind, mime, data, created_at) VALUES (?, ?, ?, ?, ?, ?)", id, itemId, kind, mime, data, Date.now());
    return id;
  }

  private mediaImg(id: string): Img | null {
    const r = this.q("SELECT mime, data FROM media WHERE id = ?", id)[0];
    return r ? { mime: String(r.mime), data: r.data as ArrayBuffer } : null;
  }

  private mediaIds(itemId: string, kind: string): string[] {
    return this.q("SELECT id FROM media WHERE item_id = ? AND kind = ? ORDER BY created_at, id", itemId, kind).map((r) => String(r.id));
  }

  private studios(): { id: number; name: string; media_id: string }[] {
    return this.q("SELECT id, name, media_id FROM studios ORDER BY id DESC") as unknown as { id: number; name: string; media_id: string }[];
  }

  // ---------------------------------------------------------------- доступ

  private allowed(userId: number): boolean {
    const fromEnv = `${setting(this.env, "ADMIN_TELEGRAM_ID")},${setting(this.env, "ALLOWED_USERS")}`
      .split(/[,\s]+/).filter(Boolean).map(Number);
    const fromDb = this.q("SELECT id FROM users").map((r) => Number(r.id));
    if (!fromEnv.length && !fromDb.length) {
      // Первый, кто написал боту, становится владельцем
      this.q("INSERT INTO users (id, added_at) VALUES (?, ?)", userId, Date.now());
      this.kvSet("owner_claimed", "1");
      return true;
    }
    return fromEnv.includes(userId) || fromDb.includes(userId);
  }

  // ---------------------------------------------------------------- вход из Worker

  async handleUpdate(update: TgUpdate, origin: string): Promise<void> {
    if (origin && origin !== this.origin()) this.kvSet("origin", origin);
    const cb = update.callback_query;
    const msg = update.message ?? cb?.message;
    const userId = update.message?.from?.id ?? cb?.from.id;
    if (!msg || !userId) return;
    const chatId = msg.chat.id;

    const firstOwner = !this.kvGet("owner_claimed") && !this.q("SELECT 1 FROM users").length;
    if (!this.allowed(userId)) {
      if (cb) await this.tg.answer(cb.id);
      await this.tg.send(chatId,
        `⛔ Нет доступа. Ваш Telegram ID: <code>${userId}</code>\nПопросите владельца отправить боту <code>/adduser ${userId}</code>.`);
      return;
    }
    if (firstOwner) {
      await this.tg.send(chatId, "🔐 Вы стали владельцем бота: им можете пользоваться только вы. Добавить коллегу — /adduser ID.");
    }

    const s = this.session(userId, chatId);
    try {
      if (cb) await this.onCallback(cb, s);
      else if (update.message) await this.onMessage(update.message, s);
    } catch (e) {
      console.error("Ошибка обработки", e);
      await this.tg.send(chatId, `❌ Ошибка: ${esc(String(e)).slice(0, 500)}\nПопробуйте ещё раз или начните заново — /new`);
    }
  }

  async getMedia(secret: string, id: string): Promise<{ data: ArrayBuffer; mime: string } | null> {
    if (secret !== this.secret()) return null;
    return this.mediaImg(id);
  }

  async feed(secret: string): Promise<string | null> {
    if (secret !== this.secret()) return null;
    const origin = this.origin();
    const items = this.q(
      "SELECT id FROM items WHERE status IN (?, ?, ?, ?) ORDER BY created_at",
      ST.QUEUED, ST.UPLOADING, ST.PUBLISHED, ST.ERROR,
    ).map((r) => this.item(String(r.id))!).filter((i) => i.listing);
    return buildFeed(
      items.map((i) => ({
        id: i.id,
        listing: i.listing!,
        photoUrls: i.photos.map((m) => `${origin}/m/${this.secret()}/${m}.jpg`),
      })),
      this.env,
    );
  }

  async stats(): Promise<Record<string, number | string>> {
    return {
      owners: this.q("SELECT COUNT(*) AS n FROM users")[0].n as number,
      studios: this.q("SELECT COUNT(*) AS n FROM studios")[0].n as number,
      items: this.q("SELECT COUNT(*) AS n FROM items WHERE status != ?", ST.DRAFT)[0].n as number,
      jobs: this.q("SELECT COUNT(*) AS n FROM jobs")[0].n as number,
    };
  }

  // ---------------------------------------------------------------- сообщения

  private async onMessage(m: TgMessage, s: Session): Promise<void> {
    const chat = m.chat.id;
    const text = (m.text ?? "").trim();

    if (text.startsWith("/")) {
      const [cmd, ...args] = text.split(/\s+/);
      switch (cmd.split("@")[0]) {
        case "/start":
        case "/new":
          return this.startNew(chat, s);
        case "/cancel":
          return this.cancel(chat, s);
        case "/list":
          return this.listItems(chat);
        case "/studios":
          return this.listStudios(chat);
        case "/feed":
          return this.feedCmd(chat);
        case "/id":
          await this.tg.send(chat, `Ваш Telegram ID: <code>${s.user_id}</code>`);
          return;
        case "/adduser":
          return this.addUser(chat, args[0]);
        case "/help":
        default:
          await this.tg.send(chat,
            "/new — новая вещь\n/list — мои объявления\n/studios — локации студии\n/feed — ссылка на фид для Авито\n" +
            "/cancel — отменить текущую вещь\n/adduser ID — дать доступ коллеге\n/id — мой Telegram ID");
          return;
      }
    }

    const hasImage = Boolean(m.photo?.length || m.document);
    switch (s.state) {
      case "studio":
        if (hasImage) return this.studioPhoto(m, s);
        break;
      case "studio_name":
        if (text) return this.saveStudio(chat, s, text.slice(0, 40));
        break;
      case "photos":
      case "new_photos":
        if (hasImage) return this.productPhoto(m, s);
        break;
      case "tag":
        if (hasImage) return this.tagPhoto(m, s);
        break;
      case "info":
        if (text) return this.itemInfo(chat, s, text);
        break;
      case "wish":
        if (text) return this.startRewrite(chat, s, text);
        break;
      case "manual":
        if (text) return this.manualValue(chat, s, text);
        break;
    }
    const hints: Record<string, string> = {
      studio: "Пришлите фото студии или выберите локацию кнопкой.",
      studio_name: "Напишите название локации текстом.",
      photos: "Пришлите фото товара или нажмите «Готово».",
      new_photos: "Пришлите фото товара или нажмите «Готово».",
      tag: "Пришлите фото бирки или нажмите «Пропустить».",
      info: "Напишите текстом: название, бренд, размер.",
      wish: "Напишите пожелание текстом или нажмите кнопку.",
      manual: "Напишите новое значение текстом.",
    };
    await this.tg.send(chat, hints[s.state] ?? "Новая вещь — /new, список — /list, помощь — /help");
  }

  private async downloadImage(m: TgMessage): Promise<Img | string> {
    let fileId = "";
    let size = 0;
    if (m.photo?.length) {
      const p = m.photo[m.photo.length - 1];
      fileId = p.file_id;
      size = p.file_size ?? 0;
    } else if (m.document) {
      const mime = m.document.mime_type ?? "";
      if (!mime.startsWith("image/")) return "Это не картинка. Пришлите фото.";
      fileId = m.document.file_id;
      size = m.document.file_size ?? 0;
    }
    if (!fileId) return "Пришлите фото.";
    if (size > MAX_FILE) return "Файл больше 2 МБ. Пришлите его как обычное фото (со сжатием), не файлом.";
    const { data } = await this.tg.download(fileId);
    if (data.byteLength > MAX_FILE) return "Файл больше 2 МБ. Пришлите его как обычное фото (со сжатием), не файлом.";
    const mime = detectMime(data);
    if (!mime) return "Формат не подходит (нужен JPG, PNG или WEBP). Пришлите как обычное фото.";
    return { data, mime };
  }

  // ---------------------------------------------------------------- сценарий

  private async startNew(chat: number, s: Session): Promise<void> {
    const id = newId("it");
    const now = Date.now();
    this.q("INSERT INTO items (id, user_id, chat_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", id, s.user_id, chat, ST.DRAFT, now, now);
    this.setSession(s, { chat_id: chat, state: "studio", item_id: id, field: null, relocate: 0 });
    const studios = this.studios();
    let text =
      "👋 Привет! Я готовлю объявления для Авито: делаю фото вещи в вашей студии, пишу заголовок и описание, " +
      "предлагаю цену и после вашего согласования публикую.\n\n<b>Шаг 1 из 4. Студия.</b>\n";
    text += studios.length
      ? "Выберите локацию или пришлите фото новой (пустая студия, без вещей)."
      : "Пришлите фото студии — пустую локацию, где будет «стоять» вещь.";
    await this.tg.send(chat, text, studios.length ? K.studiosKb(studios) : undefined);
  }

  private async cancel(chat: number, s: Session): Promise<void> {
    const it = this.item(s.item_id);
    if (it && it.status === ST.DRAFT) this.deleteItem(it.id);
    this.setSession(s, { state: "idle", item_id: null, field: null, relocate: 0 });
    await this.tg.send(chat, "Отменил. Новая вещь — /new");
  }

  private deleteItem(id: string): void {
    this.q("DELETE FROM media WHERE item_id = ?", id);
    this.q("DELETE FROM items WHERE id = ?", id);
    this.q("DELETE FROM jobs WHERE item_id = ?", id);
  }

  private async studioPhoto(m: TgMessage, s: Session): Promise<void> {
    const img = await this.downloadImage(m);
    if (typeof img === "string") {
      await this.tg.send(m.chat.id, img);
      return;
    }
    const mediaId = this.saveMedia(null, "studio", img.data, img.mime);
    this.setSession(s, { state: "studio_name", field: mediaId });
    await this.tg.send(m.chat.id,
      "Как назвать локацию? Например: «Белая стена», «Вешалка у окна». Сохраню её — в следующий раз просто выберете.",
      K.singleKb("Без названия", "studio_noname"));
  }

  private async saveStudio(chat: number, s: Session, name: string): Promise<void> {
    if (!s.field) return this.startNew(chat, s);
    this.q("INSERT INTO studios (name, media_id, created_at) VALUES (?, ?, ?)", name, s.field, Date.now());
    const studioId = Number(this.q("SELECT last_insert_rowid() AS id")[0].id);
    if (s.item_id) this.updateItem(s.item_id, { studio_id: studioId });
    await this.tg.send(chat, `📍 Локация «${esc(name)}» сохранена.`);
    await this.afterStudioSet(chat, this.setSession(s, { field: null }));
  }

  private async afterStudioSet(chat: number, s: Session): Promise<void> {
    if (s.relocate && s.item_id) {
      this.setSession(s, { relocate: 0, state: "review" });
      await this.enqueue("photos", s.item_id, chat, {}, "⏳ Переношу вещь в другую локацию…");
      return;
    }
    this.setSession(s, { state: "photos" });
    await this.tg.send(chat,
      "<b>Шаг 2 из 4. Фото товара.</b>\nПришлите фото вещи (можно альбомом, до 8 штук) обычными фото, не файлами. " +
      "Лучше на однотонном фоне и при хорошем свете. Потом нажмите «Готово».",
      K.photosDoneKb());
  }

  private async productPhoto(m: TgMessage, s: Session): Promise<void> {
    if (!s.item_id) return this.startNew(m.chat.id, s);
    if (this.mediaIds(s.item_id, "src").length >= MAX_SRC_PHOTOS) {
      await this.tg.send(m.chat.id, `Хватит ${MAX_SRC_PHOTOS} фото. Нажмите «Готово».`, K.photosDoneKb());
      return;
    }
    const img = await this.downloadImage(m);
    if (typeof img === "string") {
      await this.tg.send(m.chat.id, img);
      return;
    }
    this.saveMedia(s.item_id, "src", img.data, img.mime);
    if (m.media_group_id) {
      const fresh = this.q("INSERT OR IGNORE INTO seen_groups (id, created_at) VALUES (?, ?) RETURNING id", m.media_group_id, Date.now());
      if (!fresh.length) return;
      await this.tg.send(m.chat.id, "📷 Альбом получил. Ещё фото или «Готово».", K.photosDoneKb());
      return;
    }
    const n = this.mediaIds(s.item_id, "src").length;
    await this.tg.send(m.chat.id, `📷 Фото ${n} получил. Ещё или «Готово».`, K.photosDoneKb());
  }

  private async photosDone(chat: number, s: Session): Promise<void> {
    if (!s.item_id || !this.mediaIds(s.item_id, "src").length) {
      await this.tg.send(chat, "Сначала пришлите хотя бы одно фото вещи.");
      return;
    }
    if (s.state === "new_photos") {
      this.setSession(s, { state: "review" });
      await this.enqueue("photos", s.item_id, chat, {}, this.waitText(this.item(s.item_id)!, "photos"));
      return;
    }
    this.setSession(s, { state: "tag" });
    await this.tg.send(chat,
      `Принял фото: ${this.mediaIds(s.item_id, "src").length}.\n\n<b>Шаг 3 из 4. Бирка.</b>\n` +
      "Пришлите фото бирки (состав, размер) — так описание будет точнее.",
      K.singleKb("Бирки нет, пропустить", "tag_skip"));
  }

  private async tagPhoto(m: TgMessage, s: Session): Promise<void> {
    if (!s.item_id) return this.startNew(m.chat.id, s);
    const img = await this.downloadImage(m);
    if (typeof img === "string") {
      await this.tg.send(m.chat.id, img);
      return;
    }
    this.q("DELETE FROM media WHERE item_id = ? AND kind = 'tag'", s.item_id);
    this.saveMedia(s.item_id, "tag", img.data, img.mime);
    await this.askInfo(m.chat.id, s);
  }

  private async askInfo(chat: number, s: Session): Promise<void> {
    this.setSession(s, { state: "info" });
    await this.tg.send(chat,
      "<b>Шаг 4 из 4. Что это за товар?</b>\nНапишите одним сообщением: название, бренд, размер. " +
      "Можно добавить детали: состояние, где куплено, особенности.\n\n<i>Например: Пальто Max Mara, шерсть, размер 44, носила один сезон</i>");
  }

  private async itemInfo(chat: number, s: Session, text: string): Promise<void> {
    if (!s.item_id) return this.startNew(chat, s);
    this.updateItem(s.item_id, { user_text: text.slice(0, 1500) });
    this.setSession(s, { state: "review" });
    await this.enqueue("generate", s.item_id, chat, {}, this.waitText(this.item(s.item_id)!, "generate"));
  }

  private photoStyle(it: Item): string {
    let style = it.photo_style || setting(this.env, "PHOTO_STYLE", "cutout");
    if (!PHOTO_STYLES.includes(style)) style = "cutout";
    if (style.startsWith("ai_") && !hasImages(this.env)) style = "cutout"; // нет ключа OpenAI — бесплатная вырезка
    return style;
  }

  private waitText(it: Item, kind: "generate" | "photos"): string {
    const style = this.photoStyle(it);
    if (kind === "photos") {
      return style.startsWith("ai_") ? "⏳ Рисую фото нейросетью, 1–3 минуты…" : "⏳ Обновляю фото…";
    }
    if (style.startsWith("ai_")) return "⏳ Рисую фото нейросетью и пишу объявление… Это займёт 1–3 минуты.";
    return style === "cutout"
      ? "⏳ Ставлю вещь в студию и пишу объявление… Обычно до минуты."
      : "⏳ Пишу объявление… Обычно до минуты.";
  }


  // ---------------------------------------------------------------- кнопки

  private async onCallback(cb: TgCallback, s: Session): Promise<void> {
    const chat = cb.message!.chat.id;
    const data = cb.data ?? "";
    const [action, a, b, c] = data.split(":");
    const it = ["show", "edit", "ef", "em", "set", "sty", "ok", "drop", "pub", "rm"].includes(action) ? this.item(a) : null;

    if (it && it.busy && action !== "show") {
      await this.tg.answer(cb.id, "Подождите, ещё работаю над этой вещью…");
      return;
    }
    await this.tg.answer(cb.id);

    switch (action) {
      case "st": {
        if (s.state !== "studio" && !s.relocate) {
          await this.tg.send(chat, "Эта кнопка устарела. Новая вещь — /new");
          return;
        }
        if (a === "new") {
          this.setSession(s, { state: "studio" });
          await this.tg.send(chat, "Пришлите фото новой локации (пустая студия).");
          return;
        }
        if (!s.item_id) return this.startNew(chat, s);
        this.updateItem(s.item_id, { studio_id: Number(a) });
        return this.afterStudioSet(chat, s);
      }
      case "studio_noname":
        if (s.state === "studio_name") return this.saveStudio(chat, s, `Локация ${this.studios().length + 1}`);
        return;
      case "photos_done":
        if (s.state === "photos" || s.state === "new_photos") return this.photosDone(chat, s);
        return;
      case "tag_skip":
        if (s.state === "tag") return this.askInfo(chat, s);
        return;
      case "wish_none":
        if (s.state === "wish") return this.startRewrite(chat, s, "");
        return;
      case "stdel":
        this.q("DELETE FROM studios WHERE id = ?", Number(a));
        await this.tg.send(chat, "Локация удалена.");
        return;
    }

    if (!it) {
      await this.tg.send(chat, "Не нашёл эту вещь. Новая — /new");
      return;
    }

    switch (action) {
      case "show":
        this.setSession(s, { item_id: it.id, state: "review" });
        return this.preview(chat, it, false);
      case "edit":
        this.setSession(s, { item_id: it.id, state: "review" });
        await this.tg.send(chat, "Что изменить?", K.editMenuKb(it.id));
        return;
      case "ef":
        this.setSession(s, { item_id: it.id });
        await this.tg.send(chat, `<b>${EDITABLE[b] ?? b}</b>: как поступим?`, K.editModeKb(it.id, b, hasImages(this.env)));
        return;
      case "em":
        return this.editMode(chat, s, it, b, c);
      case "set":
        return this.setOption(chat, it, b, Number(c));
      case "sty":
        this.updateItem(it.id, { photo_style: b, photo_variant: 0 });
        this.setSession(s, { item_id: it.id, state: "review" });
        await this.enqueue("photos", it.id, chat, {}, this.waitText(this.item(it.id)!, "photos"));
        return;
      case "ok":
        await this.tg.send(chat,
          `Итоговое согласование: отправляем объявление ${isAutoload(this.env) ? "на Авито" : "в готовый пакет для публикации"}?`,
          K.confirmPublishKb(it.id));
        return;
      case "drop":
        if (it.status === ST.DRAFT) this.deleteItem(it.id);
        this.setSession(s, { state: "idle", item_id: null });
        await this.tg.send(chat, "Вещь отменена. Новая — /new");
        return;
      case "pub":
        await this.tg.removeKeyboard(chat, cb.message!.message_id);
        return this.publish(chat, s, it);
      case "rm":
        this.updateItem(it.id, { status: ST.REMOVED });
        this.kvSet("feed_dirty", "1");
        await this.tg.removeKeyboard(chat, cb.message!.message_id);
        await this.tg.send(chat, "Убрал из файла выгрузки. Авито снимет объявление при ближайшей загрузке.");
        return;
    }
  }

  private async editMode(chat: number, s: Session, it: Item, field: string, mode: string): Promise<void> {
    this.setSession(s, { item_id: it.id, field });
    if (field === "photos") {
      if (mode === "auto") {
        this.updateItem(it.id, { photo_variant: (it.photo_variant || 0) + 1 });
        this.setSession(s, { state: "review" });
        await this.enqueue("photos", it.id, chat, {}, this.waitText(it, "photos"));
      } else if (mode === "manual") {
        this.q("DELETE FROM media WHERE item_id = ? AND kind = 'src'", it.id);
        this.setSession(s, { state: "new_photos" });
        await this.tg.send(chat, "Пришлите новые фото товара, потом «Готово».", K.photosDoneKb());
      } else {
        this.setSession(s, { relocate: 1, state: "review" });
        await this.tg.send(chat, "Выберите локацию:", K.studiosKb(this.studios()));
      }
      return;
    }
    if (mode === "auto") {
      this.setSession(s, { state: "wish" });
      await this.tg.send(chat,
        "Напишите, что поменять (например: «короче», «добавь про посадку», «цену чуть ниже») или нажмите кнопку.",
        K.singleKb("Без пожеланий, просто переделай", "wish_none"));
      return;
    }
    const l = it.listing!;
    if (field === "condition") {
      await this.tg.send(chat, "Выберите состояние:", K.optionsKb(it.id, field, CONDITIONS));
    } else if (field === "goods_type") {
      await this.tg.send(chat, "Выберите раздел:", K.optionsKb(it.id, field, GOODS_TYPES));
    } else if (field === "apparel" && APPAREL[l.goods_type]) {
      await this.tg.send(chat, "Выберите вид вещи:", K.optionsKb(it.id, field, APPAREL[l.goods_type]));
    } else {
      this.setSession(s, { state: "manual" });
      let hint = field === "price" ? "Напишите новую цену числом, например 3500." : "Напишите новый вариант:";
      const current = (l as unknown as Record<string, unknown>)[field];
      if (current && field !== "description") hint += `\nСейчас: <code>${esc(current)}</code>`;
      await this.tg.send(chat, hint);
    }
  }

  private async setOption(chat: number, it: Item, field: string, index: number): Promise<void> {
    const l = it.listing!;
    const options = field === "condition" ? CONDITIONS : field === "goods_type" ? GOODS_TYPES : APPAREL[l.goods_type] ?? [];
    const value = options[index];
    if (!value) return;
    (l as unknown as Record<string, unknown>)[field] = value;
    if (field === "goods_type" && !(APPAREL[value] ?? []).includes(l.apparel)) l.apparel = "";
    this.updateItem(it.id, { listing: l });
    await this.preview(chat, this.item(it.id)!, false);
  }

  private async manualValue(chat: number, s: Session, text: string): Promise<void> {
    const it = this.item(s.item_id);
    if (!it?.listing || !s.field) return this.startNew(chat, s);
    const l = it.listing;
    if (s.field === "price") {
      const digits = text.replace(/\D/g, "");
      if (!digits) {
        await this.tg.send(chat, "Нужна цена числом, например 3500.");
        return;
      }
      l.price = Number(digits);
      l.price_comment = "цену указали вы";
    } else if (s.field === "title") {
      if (text.length > TITLE_MAX) {
        await this.tg.send(chat, `На Авито заголовок до ${TITLE_MAX} символов, у вас ${text.length}. Сократите.`);
        return;
      }
      l.title = text;
    } else {
      (l as unknown as Record<string, unknown>)[s.field] = text;
    }
    this.updateItem(it.id, { listing: l });
    this.setSession(s, { state: "review" });
    await this.preview(chat, this.item(it.id)!, false);
  }

  private async startRewrite(chat: number, s: Session, wish: string): Promise<void> {
    if (!s.item_id || !s.field) return this.startNew(chat, s);
    this.setSession(s, { state: "review" });
    await this.enqueue("rewrite", s.item_id, chat, { field: s.field, wish }, "⏳ Переделываю…");
  }

  private async publish(chat: number, s: Session, it: Item): Promise<void> {
    if (!it.listing) return;
    if (it.status !== ST.DRAFT && it.status !== ST.ERROR) {
      await this.tg.send(chat, "Эта вещь уже отправлена. Список — /list");
      return;
    }
    this.setSession(s, { state: "idle", item_id: null, field: null });
    if (isAutoload(this.env)) {
      this.updateItem(it.id, { status: ST.QUEUED, last_error: null });
      await this.tg.send(chat,
        "🚀 Поставил в очередь на Авито. Авито принимает выгрузку не чаще раза в час, поэтому публикация может занять " +
        "до часа. Пришлю ссылку, когда объявление появится.\n\nСледующая вещь — /new");
      return;
    }
    await this.enqueue("pack", it.id, chat, {}, "📦 Собираю пакет…");
  }

  // ---------------------------------------------------------------- показ объявления

  private renderListing(it: Item): string {
    const l = it.listing!;
    const lines = [
      `<b>${esc(l.title)}</b>`,
      "",
      `💰 <b>${formatPrice(l.price)}</b>` + (l.price_comment ? ` — <i>${esc(l.price_comment)}</i>` : ""),
      "📂 " + esc([l.goods_type, l.apparel].filter(Boolean).join(" · ")),
      `📏 Размер: ${esc(l.size || "—")}   ✨ Состояние: ${esc(l.condition || "—")}`,
      `🏷 Бренд: ${esc(l.brand || "—")}   🎨 Цвет: ${esc(l.color || "—")}`,
      `📸 Фото: ${STYLE_NAMES[this.photoStyle(it)] ?? ""}`,
      `✍️ Текст: ${hasClaude(this.env) ? "Claude" : "бесплатная нейросеть Cloudflare — проверьте формулировки"}`,
      "",
    ];
    let desc = fullDescription(l, this.env);
    if (desc.length > 2800) desc = desc.slice(0, 2800) + "…";
    lines.push(esc(desc));
    if (l.item_summary) lines.push("", `🔎 <i>Для вас: ${esc(l.item_summary)}</i>`);
    lines.push("", "<b>Всё ли вас устраивает?</b>");
    return lines.join("\n");
  }

  private filesFor(ids: string[]): { data: ArrayBuffer; name: string; mime: string }[] {
    return ids.slice(0, MAX_IMAGES).map((id, i) => {
      const img = this.mediaImg(id);
      return img ? { data: img.data, mime: img.mime, name: `photo_${i + 1}.${img.mime.split("/")[1] ?? "jpg"}` } : null;
    }).filter(Boolean) as { data: ArrayBuffer; name: string; mime: string }[];
  }

  private async preview(chat: number, it: Item, withPhotos: boolean): Promise<void> {
    if (!it.listing) {
      await this.tg.send(chat, "Объявление ещё не готово. Подождите или начните заново — /new");
      return;
    }
    if (withPhotos && it.photos.length) await this.tg.sendFiles(chat, this.filesFor(it.photos));
    await this.tg.send(chat, this.renderListing(it), K.reviewKb(it.id));
  }

  // ---------------------------------------------------------------- очередь задач

  private async enqueue(type: string, itemId: string, chat: number, data: Job["data"], waitText: string): Promise<void> {
    const wait = await this.tg.send(chat, waitText);
    this.updateItem(itemId, { busy: 1 });
    this.q("INSERT INTO jobs (type, item_id, chat_id, data, created_at) VALUES (?, ?, ?, ?, ?)",
      type, itemId, chat, JSON.stringify({ ...data, waitId: wait.message_id }), Date.now());
    const current = await this.ctx.storage.getAlarm();
    if (!current || current > Date.now() + 1000) await this.ctx.storage.setAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const row = this.q("SELECT * FROM jobs ORDER BY id LIMIT 1")[0];
    if (!row) return;
    this.q("DELETE FROM jobs WHERE id = ?", row.id);
    const job: Job = {
      id: Number(row.id),
      type: String(row.type),
      item_id: String(row.item_id),
      chat_id: Number(row.chat_id),
      data: JSON.parse(String(row.data || "{}")),
    };
    try {
      await this.runJob(job);
    } catch (e) {
      console.error("Задача", job.type, e);
      await this.tg.send(job.chat_id, `❌ Не получилось: ${esc(String(e)).slice(0, 600)}\nПопробуйте ещё раз.`).catch(() => {});
      if (job.type === "generate") {
        const s = this.q("SELECT * FROM sessions WHERE item_id = ?", job.item_id)[0] as unknown as Session | undefined;
        if (s) this.setSession(s, { state: "info" });
        await this.tg.send(job.chat_id, "Напишите описание вещи ещё раз — попробую снова.").catch(() => {});
      }
    } finally {
      if (this.item(job.item_id)) this.updateItem(job.item_id, { busy: 0 });
      if (job.data.waitId) await this.tg.deleteMessage(job.chat_id, job.data.waitId);
      if (this.q("SELECT 1 FROM jobs LIMIT 1").length) await this.ctx.storage.setAlarm(Date.now() + 100);
    }
  }

  private async runJob(job: Job): Promise<void> {
    const it = this.item(job.item_id);
    if (!it) return;
    const chat = job.chat_id;

    if (job.type === "generate") {
      const src = this.mediaIds(it.id, "src").map((id) => this.mediaImg(id)!).filter(Boolean);
      const tagId = this.mediaIds(it.id, "tag")[0];
      const [listing] = await Promise.all([
        makeListing(this.env, src, tagId ? this.mediaImg(tagId) : null, it.user_text),
        this.buildPhotos(it, chat),
      ]);
      this.updateItem(it.id, { listing });
      return this.preview(chat, this.item(it.id)!, true);
    }
    if (job.type === "photos") {
      await this.buildPhotos(it, chat);
      return this.preview(chat, this.item(it.id)!, true);
    }
    if (job.type === "rewrite") {
      if (!it.listing || !job.data.field) return;
      const photos = (it.photos.length ? it.photos : this.mediaIds(it.id, "src")).slice(0, 3).map((id) => this.mediaImg(id)!).filter(Boolean);
      const listing = await rewriteField(this.env, it.listing, job.data.field, job.data.wish ?? "", photos);
      this.updateItem(it.id, { listing });
      return this.preview(chat, this.item(it.id)!, false);
    }
    if (job.type === "pack") return this.sendPack(chat, it);
  }

  private async buildPhotos(it: Item, chat: number): Promise<void> {
    const srcIds = this.mediaIds(it.id, "src");
    const style = this.photoStyle(it);
    const keepOriginals = setting(this.env, "KEEP_ORIGINAL_PHOTOS", "1") !== "0";
    const studio = it.studio_id ? (this.q("SELECT media_id FROM studios WHERE id = ?", it.studio_id)[0] as Row | undefined) : undefined;
    const studioImg = studio ? this.mediaImg(String(studio.media_id)) : null;

    this.q("DELETE FROM media WHERE item_id = ? AND kind = 'out'", it.id);
    let photos = srcIds;

    if (style === "cutout" && studioImg && srcIds.length) {
      // Бесплатно: каждое фото вещи вырезаем и ставим в студию; вещь остаётся как на фото
      const outs: string[] = [];
      let error = "";
      for (const [i, id] of srcIds.slice(0, MAX_IMAGES).entries()) {
        try {
          const out = await cutoutIntoStudio(this.env, studioImg, this.mediaImg(id)!, (it.photo_variant || 0) + i);
          outs.push(this.saveMedia(it.id, "out", out, "image/jpeg"));
        } catch (e) {
          error = String(e);
          console.warn("Вырезка", error);
        }
      }
      if (outs.length) photos = outs;
      else {
        await this.tg.send(chat,
          `⚠️ Не получилось поставить вещь в студию (${esc(error).slice(0, 300)}). Беру ваши исходные фото.`);
      }
    } else if (style.startsWith("ai_") && studioImg && srcIds.length) {
      const count = Math.min(6, Math.max(1, Number(setting(this.env, "AI_MAX_IMAGES", "3")) || 3));
      const variant = it.photo_variant || 0;
      const results = await Promise.allSettled(
        Array.from({ length: count }, (_, i) =>
          generateImage(this.env, studioImg, this.mediaImg(srcIds[i % srcIds.length])!, style, variant + i)),
      );
      const outs: string[] = [];
      for (const r of results) {
        if (r.status === "fulfilled") outs.push(this.saveMedia(it.id, "out", r.value, "image/jpeg"));
      }
      const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      if (outs.length) {
        photos = [...outs, ...(keepOriginals ? srcIds.slice(0, 2) : [])];
        if (failed) console.warn("Часть фото не получилась:", String(failed.reason));
      } else {
        await this.tg.send(chat,
          `⚠️ Нейросеть не нарисовала фото (${esc(String(failed?.reason ?? "нет ответа")).slice(0, 300)}). Беру ваши исходные фото.`);
      }
    }
    this.updateItem(it.id, { photos });
  }

  private async sendPack(chat: number, it: Item): Promise<void> {
    const l = it.listing!;
    await this.tg.sendFiles(chat, this.filesFor(it.photos), true);
    await this.tg.send(chat, `<b>Заголовок</b> (нажмите, чтобы скопировать):\n<code>${esc(l.title)}</code>`);
    await this.tg.send(chat, `<code>${esc(fullDescription(l, this.env))}</code>`);
    await this.tg.send(chat,
      `<b>Цена:</b> <code>${Math.round(l.price)}</code>\n` +
      `<b>Раздел:</b> ${esc(CATEGORY)} → ${esc(l.goods_type)}${l.apparel ? ` → ${esc(l.apparel)}` : ""}\n` +
      `<b>Размер:</b> ${esc(l.size || "—")}\n<b>Состояние:</b> ${esc(l.condition || "—")}\n` +
      `<b>Бренд:</b> ${esc(l.brand || "—")}\n<b>Цвет:</b> ${esc(l.color || "—")}\n\n` +
      "📦 Пакет готов: фото выше файлами, текст копируется нажатием. Следующая вещь — /new");
    this.updateItem(it.id, { status: ST.MANUAL });
  }

  // ---------------------------------------------------------------- команды

  private async listItems(chat: number): Promise<void> {
    const rows = this.q("SELECT id FROM items WHERE status != ? ORDER BY updated_at DESC LIMIT 15", ST.DRAFT);
    if (!rows.length) {
      await this.tg.send(chat, "Пока пусто. Новая вещь — /new");
      return;
    }
    const names: Record<string, string> = {
      queued: "⏳ ждёт выгрузки", uploading: "⏳ выгружается", published: "✅ на Авито",
      manual: "📦 пакет выдан", error: "⚠️ ошибка", removed: "снято",
    };
    for (const r of rows) {
      const it = this.item(String(r.id))!;
      let text = `<b>${esc(it.listing?.title ?? it.id)}</b> — ${formatPrice(it.listing?.price ?? 0)}\n${names[it.status] ?? it.status}`;
      if (it.avito_url) text += `\n${esc(it.avito_url)}`;
      if (it.status === ST.ERROR && it.last_error) text += `\n<i>${esc(it.last_error.slice(0, 500))}</i>`;
      const canRemove = [ST.QUEUED, ST.UPLOADING, ST.PUBLISHED, ST.ERROR].includes(it.status as never);
      await this.tg.send(chat, text, K.listItemKb(it.id, canRemove, it.status === ST.ERROR));
    }
  }

  private async listStudios(chat: number): Promise<void> {
    const studios = this.studios();
    if (!studios.length) {
      await this.tg.send(chat, "Локаций пока нет. Они добавятся, когда пришлёте фото студии в /new.");
      return;
    }
    await this.tg.sendFiles(chat, this.filesFor(studios.slice(0, 10).map((s) => s.media_id)));
    await this.tg.send(chat, "Локации студии. Нажмите, чтобы удалить:",
      studios.map((s) => [{ text: `🗑 ${s.name}`, callback_data: `stdel:${s.id}` }]));
  }

  private async feedCmd(chat: number): Promise<void> {
    if (!isAutoload(this.env)) {
      await this.tg.send(chat,
        "Сейчас режим <b>manual</b>: я присылаю готовый пакет, а публикуете вы. Чтобы бот выкладывал сам, нужен " +
        "профиль-компания с подпиской на Авито и секрет PUBLISH_MODE = autoload в Cloudflare.");
      return;
    }
    await this.tg.send(chat,
      "Ссылка на файл выгрузки (вставьте её один раз в Авито → Автозагрузка → Настройки):\n" +
      `<code>${esc(`${this.origin()}/feed/${this.secret()}.xml`)}</code>`);
  }

  private async addUser(chat: number, arg?: string): Promise<void> {
    const id = Number(arg);
    if (!Number.isSafeInteger(id) || id <= 0) {
      await this.tg.send(chat, "Напишите так: <code>/adduser 123456789</code>. ID человек узнает, написав боту.");
      return;
    }
    this.q("INSERT OR IGNORE INTO users (id, added_at) VALUES (?, ?)", id, Date.now());
    await this.tg.send(chat, `✅ Доступ выдан: <code>${id}</code>`);
  }

  // ---------------------------------------------------------------- по расписанию

  async cron(): Promise<void> {
    const weekAgo = Date.now() - 7 * 86400_000;
    for (const r of this.q("SELECT id FROM items WHERE status = ? AND updated_at < ?", ST.DRAFT, weekAgo)) this.deleteItem(String(r.id));
    this.q("DELETE FROM media WHERE kind = 'studio' AND item_id IS NULL AND id NOT IN (SELECT media_id FROM studios) AND created_at < ?", Date.now() - 86400_000);
    this.q("DELETE FROM seen_groups WHERE created_at < ?", Date.now() - 86400_000);
    if (isAutoload(this.env)) await this.publisherTick();
  }

  private async publisherTick(): Promise<void> {
    this.avito ??= new Avito(this.env);
    const now = Date.now();
    const queued = this.q("SELECT id FROM items WHERE status = ?", ST.QUEUED).map((r) => String(r.id));
    const dirty = this.kvGet("feed_dirty") === "1";
    const last = Number(this.kvGet("last_upload", "0"));

    if ((queued.length || dirty) && now - last >= UPLOAD_INTERVAL) {
      try {
        await this.avito.triggerUpload();
        this.kvSet("last_upload", String(now));
        this.kvSet("feed_dirty", "0");
        for (const id of queued) this.updateItem(id, { status: ST.UPLOADING });
      } catch (e) {
        console.warn("Запуск загрузки Авито", String(e));
        this.kvSet("last_upload", String(now - UPLOAD_INTERVAL + 600_000)); // повтор через 10 минут
      }
    }

    for (const r of this.q("SELECT id FROM items WHERE status = ?", ST.UPLOADING)) {
      const it = this.item(String(r.id))!;
      if (now - Number(this.kvGet("last_upload", "0")) < 120_000) continue;
      const status = await this.avito.itemStatus(it.id);
      const title = esc(it.listing?.title ?? it.id);
      if (status?.url && status.avito_status === "active") {
        this.updateItem(it.id, { status: ST.PUBLISHED, avito_id: status.avito_id ?? null, avito_url: status.url, published_at: now });
        await this.tg.send(it.chat_id, `✅ Опубликовано на Авито: <b>${title}</b>\n${esc(status.url)}`);
        continue;
      }
      const hasError = status && (
        (status.section?.slug ?? "").startsWith("error") ||
        (status.messages ?? []).some((m) => m.type === "error") ||
        ["blocked", "rejected"].includes(status.avito_status ?? "")
      );
      if (hasError) {
        const text = describeStatus(status!);
        this.updateItem(it.id, { status: ST.ERROR, last_error: text });
        await this.tg.send(it.chat_id, `⚠️ Авито не принял <b>${title}</b>:\n${esc(text)}\n\nИсправьте через /list.`);
      } else if (now - it.updated_at > 6 * 3600_000) {
        this.updateItem(it.id, { status: ST.ERROR, last_error: "Авито не обработал объявление за 6 часов" });
        await this.tg.send(it.chat_id, `⚠️ <b>${title}</b>: Авито долго не обрабатывает. Проверьте раздел Автозагрузка в кабинете.`);
      }
    }
  }
}

const PHOTO_STYLES = ["cutout", "ai_studio", "ai_model", "original"];
