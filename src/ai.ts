/**
 * Тексты объявления: разбор вещи по фото и бирке, заголовок, описание, цена.
 * Есть ключ Claude — пишет Claude. Нет — бесплатная нейросеть Cloudflare (Workers AI).
 */
import type { Env } from "./env";
import { DEFAULT_TEXT_MODEL, FALLBACK_TEXT_MODEL, hasClaude, setting } from "./env";
import { APPAREL, CONDITIONS, GOODS_TYPES, Listing, TITLE_MAX, normalize } from "./fields";
import { toBase64 } from "./util";

export interface Img { data: ArrayBuffer; mime: string }
type Part = { img: Img } | { text: string };

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
- Пиши грамотно, на естественном русском языке.`;

function systemPrompt(env: Env): string {
  const rules = setting(env, "PRICE_RULES");
  return rules ? `${SYSTEM}\n\nПравила цены от продавца (соблюдай их):\n${rules}` : SYSTEM;
}

// ---------------------------------------------------------------- Claude (платно)

async function askClaude(env: Env, parts: Part[], schema: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = { name: "save_listing", description: "Сохранить объявление для Авито.", input_schema: schema };
  const content = parts.map((p) =>
    "img" in p
      ? { type: "image", source: { type: "base64", media_type: p.img.mime, data: toBase64(p.img.data) } }
      : { type: "text", text: p.text },
  );
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
      system: systemPrompt(env),
      tools: [tool],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content }],
    }),
  });
  const data = (await res.json()) as { content?: { type: string; input?: Record<string, unknown> }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(`Claude ${res.status}: ${data.error?.message ?? "ошибка"}`);
  const block = data.content?.find((b) => b.type === "tool_use");
  if (!block?.input) throw new Error("Claude не вернул объявление");
  return block.input;
}

// ---------------------------------------------------------------- Cloudflare Workers AI (бесплатно)

type AiRunner = { run(model: string, input: Record<string, unknown>): Promise<unknown> };

/** Достаёт JSON из ответа модели: объект как есть или первый {...} в тексте. */
export function parseJsonAnswer(raw: unknown): Record<string, unknown> | null {
  const value = raw && typeof raw === "object" && "response" in raw ? (raw as { response: unknown }).response : raw;
  if (value && typeof value === "object") return value as Record<string, unknown>;
  const text = String(value ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function askFree(env: Env, parts: Part[], schema: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ai = env.AI as unknown as AiRunner;
  const fieldsHelp = Object.entries(schema.properties as Record<string, Record<string, unknown>>)
    .map(([k, v]) => `- ${k}: ${v.description ?? ""}${v.enum ? ` Одно из: ${(v.enum as string[]).join(", ")}.` : ""}`)
    .join("\n");
  const content = parts.map((p) =>
    "img" in p
      ? { type: "image_url", image_url: { url: `data:${p.img.mime};base64,${toBase64(p.img.data)}` } }
      : { type: "text", text: p.text },
  );
  content.push({ type: "text", text: `Ответь только JSON-объектом с полями:\n${fieldsHelp}` });

  const models = [setting(env, "TEXT_MODEL", DEFAULT_TEXT_MODEL), FALLBACK_TEXT_MODEL].filter((m, i, a) => a.indexOf(m) === i);
  let lastError = "";
  for (const model of models) {
    try {
      const input: Record<string, unknown> = {
        messages: [
          { role: "system", content: systemPrompt(env) },
          { role: "user", content },
        ],
        max_tokens: 1500,
        temperature: 0.4,
      };
      if (model.includes("llama-4")) input.response_format = { type: "json_schema", json_schema: schema };
      else input.guided_json = schema;
      const parsed = parseJsonAnswer(await ai.run(model, input));
      if (parsed) return parsed;
      lastError = `${model}: ответ не в формате JSON`;
    } catch (e) {
      lastError = `${model}: ${String(e)}`;
    }
    console.warn("Бесплатная нейросеть", lastError);
  }
  if (/4006|allocation|limit/i.test(lastError)) {
    throw new Error("закончился бесплатный дневной лимит нейросети Cloudflare. Он обновится в 03:00 по Москве");
  }
  throw new Error(`нейросеть Cloudflare не ответила (${lastError})`);
}

function ask(env: Env, parts: Part[], properties: Record<string, unknown>): Promise<Record<string, unknown>> {
  const schema = { type: "object", properties, required: Object.keys(properties) };
  return hasClaude(env) ? askClaude(env, parts, schema) : askFree(env, parts, schema);
}

// ---------------------------------------------------------------- для бота

export async function makeListing(env: Env, photos: Img[], tag: Img | null, userText: string): Promise<Listing> {
  // Бесплатной модели даём меньше фото: каждое фото тратит дневной лимит
  const parts: Part[] = photos.slice(0, hasClaude(env) ? 4 : 2).map((img) => ({ img }));
  if (tag) parts.push({ text: "Следующее фото — бирка вещи:" }, { img: tag });
  parts.push({ text: `Продавец пишет о вещи: «${userText}».\nПодготовь объявление.` });
  return normalize((await ask(env, parts, FIELDS)) as Partial<Listing>);
}

export async function rewriteField(env: Env, listing: Listing, field: string, wish: string, photos: Img[]): Promise<Listing> {
  const props: Record<string, unknown> = { [field]: FIELDS[field] };
  if (field === "price") props.price_comment = FIELDS.price_comment;
  const parts: Part[] = photos.slice(0, hasClaude(env) ? 3 : 1).map((img) => ({ img }));
  parts.push({
    text:
      "Текущее объявление:\n" + JSON.stringify(listing, null, 1) +
      `\n\nПеределай поле «${field}». Пожелание продавца: ${wish.trim() || "сделай другой, более удачный вариант."}`,
  });
  const update = await ask(env, parts, props);
  return normalize({ ...listing, ...(update as Partial<Listing>) });
}
