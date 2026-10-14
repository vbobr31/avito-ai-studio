/**
 * Avito AI Studio — Telegram-бот на Cloudflare Workers.
 *
 * Адреса Worker:
 *   GET  /          — проверка: что настроено, что нет
 *   GET  /setup     — подключить бота к Telegram (webhook) — открыть один раз после деплоя
 *   POST /telegram  — сюда Telegram присылает сообщения
 *   GET  /m/…       — фото для Telegram и Авито
 *   GET  /feed/…    — файл выгрузки для Автозагрузки Авито
 */
import type { Env } from "./env";
import { hasImages, isAutoload, setting } from "./env";
import { Telegram, TgUpdate } from "./telegram";
import { esc, sha256hex } from "./util";

export { BotDO } from "./bot";

const stub = (env: Env) => env.BOT.get(env.BOT.idFromName("main"));

async function hookSecret(env: Env): Promise<string> {
  const own = setting(env, "TELEGRAM_WEBHOOK_SECRET");
  if (/^[A-Za-z0-9_-]{1,256}$/.test(own)) return own;
  return (await sha256hex("webhook:" + env.TELEGRAM_BOT_TOKEN)).slice(0, 48);
}

function page(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${esc(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#1d1d1f}` +
      `li{margin:6px 0}code{background:#f2f2f2;padding:1px 4px;border-radius:4px}.ok{color:#137333}.bad{color:#b3261e}</style></head>` +
      `<body><h1>${esc(title)}</h1>${body}</body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

const mark = (ok: boolean, text: string) => `<li class="${ok ? "ok" : "bad"}">${ok ? "✅" : "❌"} ${text}</li>`;

async function statusPage(env: Env, origin: string): Promise<Response> {
  const items: string[] = [];
  let webhookOk = false;
  if (!env.TELEGRAM_BOT_TOKEN) {
    items.push(mark(false, "Нет секрета <code>TELEGRAM_BOT_TOKEN</code>"));
  } else {
    const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
    try {
      const me = await tg.call<{ username: string }>("getMe");
      items.push(mark(true, `Токен Telegram работает: @${esc(me.username)}`));
      const info = await tg.call<{ url: string; last_error_message?: string; pending_update_count?: number }>("getWebhookInfo");
      webhookOk = info.url === `${origin}/telegram`;
      items.push(mark(webhookOk, webhookOk
        ? "Бот подключён к этому Worker"
        : `Бот не подключён к этому Worker — откройте <a href="/setup">/setup</a>`));
      if (info.last_error_message) items.push(mark(false, `Последняя ошибка доставки от Telegram: ${esc(info.last_error_message)}`));
    } catch (e) {
      items.push(mark(false, `Токен Telegram не подходит: ${esc(String(e))}. Обновите секрет <code>TELEGRAM_BOT_TOKEN</code>.`));
    }
  }
  items.push(`<li>✍️ Тексты и цена: ${setting(env, "ANTHROPIC_API_KEY") ? "Claude (платно)" : "бесплатная нейросеть Cloudflare"}</li>`);
  items.push(`<li>📸 Фото: ${hasImages(env) ? "вырезка в студию + нейросеть OpenAI по кнопке (платно)" : "вырезка вещи и постановка в студию (бесплатно)"}</li>`);
  items.push(mark(Boolean(env.AI), "Нейросети Cloudflare подключены"));
  items.push(mark(Boolean(env.IMAGES), "Обработка картинок Cloudflare подключена"));
  if (isAutoload(env)) {
    for (const key of ["AVITO_CLIENT_ID", "AVITO_CLIENT_SECRET", "AVITO_ADDRESS"] as const) {
      items.push(mark(Boolean(setting(env, key)), `<code>${key}</code> для автопубликации на Авито`));
    }
  } else {
    items.push(`<li>ℹ️ Публикация: готовый пакет, выкладываете вы (<code>PUBLISH_MODE</code> = manual)</li>`);
  }
  try {
    const st = await stub(env).stats();
    items.push(`<li>📦 В базе: владельцев ${st.owners}, локаций ${st.studios}, объявлений ${st.items}, задач в очереди ${st.jobs}</li>`);
  } catch (e) {
    items.push(mark(false, `База не отвечает: ${esc(String(e))}`));
  }
  return page("Avito AI Studio", `<ul>${items.join("")}</ul>` + (webhookOk ? "<p>Всё готово — напишите боту /start.</p>" : ""));
}

async function setup(env: Env, origin: string): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN) return page("Настройка", "<p class=bad>Сначала добавьте секрет <code>TELEGRAM_BOT_TOKEN</code>.</p>", 400);
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN);
  try {
    await tg.call("setWebhook", {
      url: `${origin}/telegram`,
      secret_token: await hookSecret(env),
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
      max_connections: 10,
    });
    await tg.call("setMyCommands", {
      commands: [
        { command: "new", description: "Новая вещь" },
        { command: "list", description: "Мои объявления" },
        { command: "studios", description: "Локации студии" },
        { command: "feed", description: "Ссылка на фид для Авито" },
        { command: "cancel", description: "Отменить текущую вещь" },
        { command: "help", description: "Помощь" },
      ],
    });
    const me = await tg.call<{ username: string }>("getMe");
    return page("Бот подключён",
      `<p class=ok>✅ @${esc(me.username)} теперь работает через этот Worker.</p>` +
      `<p>Откройте бота в Telegram и отправьте <code>/start</code>. Первый, кто напишет, станет владельцем.</p>` +
      `<p><a href="/">Проверить настройки</a></p>`);
  } catch (e) {
    return page("Ошибка подключения", `<p class=bad>${esc(String(e))}</p><p>Проверьте секрет <code>TELEGRAM_BOT_TOKEN</code>.</p>`, 500);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;
    const path = url.pathname;

    if (request.method === "POST" && path === "/telegram") {
      if (!env.TELEGRAM_BOT_TOKEN) return new Response("Not configured", { status: 503 });
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== (await hookSecret(env))) {
        return new Response("Forbidden", { status: 403 });
      }
      try {
        const update = (await request.json()) as TgUpdate;
        await stub(env).handleUpdate(update, origin);
      } catch (e) {
        // Отвечаем 200 в любом случае, иначе Telegram будет бесконечно повторять то же сообщение
        console.error("Ошибка обработки сообщения", e);
      }
      return new Response("OK");
    }

    if (request.method === "GET") {
      if (path === "/" || path === "") return statusPage(env, origin);
      if (path === "/setup") return setup(env, origin);

      const media = path.match(/^\/m\/([\w-]+)\/([\w-]+)\.jpg$/);
      if (media) {
        const img = await stub(env).getMedia(media[1], media[2]);
        if (!img) return new Response("Not found", { status: 404 });
        return new Response(img.data, { headers: { "content-type": img.mime, "cache-control": "public, max-age=86400" } });
      }

      const feed = path.match(/^\/feed\/([\w-]+)\.xml$/);
      if (feed) {
        const xml = await stub(env).feed(feed[1]);
        if (xml === null) return new Response("Not found", { status: 404 });
        return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
      }
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(stub(env).cron());
  },
} satisfies ExportedHandler<Env>;
