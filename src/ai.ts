/** Claude API: разбор вещи по фото и бирке, заголовок, описание, цена. */
import type { Env } from "./env";
import { setting } from "./env";
import { APPAREL, CONDITIONS, GOODS_TYPES, Listing, TITLE_MAX, normalize } from "./fields";
import { toBase64 } from "./util";

export interface Img { data: ArrayBuffer; mime: string }

const FIELDS: Record<string, Record<string, unknown>> = {
  title: { type: "string", description: `Заголовок объявления, не длиннее ${TITLE_MAX} символов: вид вещи, бренд, ключевая деталь.` },
  description: { type: "string", description: "Описание без контактов, ссылок, эмодзи и markdown. Абзацы через пустую строку." },
  price: { type: "integer", description: "Цена в рублях, целое число, кратное 100." },
  price_comment: { type: "string", description: "Одной фразой: почему такая цена." },
  goods_type: { type: "string", enum: GOODS_TYPES },
  apparel: {
    type: "string",
    description:
      "Вид одежды. Женская: " + APPAREL["Женская одежда"].join(", ") +
      ". Мужская: " + APPAREL["Мужская одежда"].join(", ") + ". Для сумок и аксессуаров — пустая строка.",
  },
  size: { type: "string", description: "Размер, как указал продавец или как на бирке." },
  condition: { type: "string", enum: CONDITIONS },
  brand: { type: "string" },
  color: { type: "string", description: "Основной цвет одним-двумя словами." },
  item_summary: { type: "string", description: "Коротко для продавца: что за вещь, состав с бирки, заметные дефекты, что проверить." },
};

const SYSTEM = `Ты опытный продавец одежды на Авито. По фото вещи, фото бирки и словам продавца ты готовишь объявление.

Правила:
- Все вещи оригинальные. Бренд не ставь под сомнение, не пиши «реплика», «копия», «люкс-копия».
- Пиши только то, что видно на фото, написано на бирке или сказал продавец. Не придумывай состав, сезон, страну, замеры.
- Заголовок: вид вещи + бренд + важная деталь (модель, цвет или материал). Без восклицательных знаков, капса, слов «срочно», «торг».
- Описание: 2–4 коротких абзаца. Что за вещь, ткань и посадка, честное состояние (дефекты, если видны), размер. Без контактов, ссылок, эмодзи, хештегов.
- Состояние «Новое с биркой» — только если бирка магазина видна на вещи.
- Цена: реалистичная цена перепродажи на Авито в России для этого бренда, вида вещи и состояния, кратная 100 рублям.
- Язык — русский.`;

function imageBlock(img: Img) {
  return { type: "image", source: { type: "base64", media_type: img.mime, data: toBase64(img.data) } };
}

async function callTool(env: Env, content: unknown[], tool: Record<string, unknown>): Promise<Record<string, unknown>> {
  let system = SYSTEM;
  const rules = setting(env, "PRICE_RULES");
  if (rules) system += `\n\nПравила цены от продавца (соблюдай их):\n${rules}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": setting(env, "ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: setting(env, "CLAUDE_MODEL", "claude-sonnet-5-5"),
      max_tokens: 2000,
      system,
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content }],
    }),
  });
  const data = (await res.json()) as {
    content?: { type: string; input?: Record<string, unknown> }[];
    error?: { message?: string };
  };
  if (!res.ok) throw new Error(`Claude ${res.status}: ${data.error?.message ?? "ошибка"}`);
  const block = data.content?.find((b) => b.type === "tool_use");
  if (!block?.input) throw new Error("Claude не вернул объявление");
  return block.input;
}

export async function makeListing(env: Env, photos: Img[], tag: Img | null, userText: string): Promise<Listing> {
  const content: unknown[] = photos.slice(0, 4).map(imageBlock);
  if (tag) {
    content.push({ type: "text", text: "Следующее фото — бирка вещи:" });
    content.push(imageBlock(tag));
  }
  content.push({ type: "text", text: `Продавец пишет о вещи: «${userText}».\nПодготовь объявление и сохрани его инструментом.` });
  const tool = {
    name: "save_listing",
    description: "Сохранить готовое объявление для Авито.",
    input_schema: { type: "object", properties: FIELDS, required: Object.keys(FIELDS) },
  };
  return normalize((await callTool(env, content, tool)) as Partial<Listing>);
}

export async function rewriteField(env: Env, listing: Listing, field: string, wish: string, photos: Img[]): Promise<Listing> {
  const props: Record<string, unknown> = { [field]: FIELDS[field] };
  if (field === "price") props.price_comment = FIELDS.price_comment;
  const tool = {
    name: "save_field",
    description: "Сохранить новый вариант поля объявления.",
    input_schema: { type: "object", properties: props, required: Object.keys(props) },
  };
  const content: unknown[] = photos.slice(0, 3).map(imageBlock);
  content.push({
    type: "text",
    text:
      "Текущее объявление:\n" + JSON.stringify(listing, null, 1) +
      `\n\nПеределай поле «${field}». Пожелание продавца: ${wish.trim() || "сделай другой, более удачный вариант."}`,
  });
  const update = await callTool(env, content, tool);
  return normalize({ ...listing, ...(update as Partial<Listing>) });
}
