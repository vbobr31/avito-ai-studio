import type { BotDO } from "./bot";

/** Все настройки задаются в Cloudflare → Worker → Settings → Variables and Secrets (тип Secret). */
export interface Env {
  BOT: DurableObjectNamespace<BotDO>;
  AI: Ai; // бесплатные нейросети Cloudflare (Workers AI)
  IMAGES: ImagesBinding; // обработка картинок Cloudflare: вырезка фона, наложение на студию

  // Обязательно
  TELEGRAM_BOT_TOKEN: string;

  // Платные нейросети — необязательно. Без ключей работают бесплатные нейросети Cloudflare
  ANTHROPIC_API_KEY?: string;
  TEXT_MODEL?: string; // бесплатная модель Cloudflare для текстов

  // Картинки нейросетью
  OPENAI_API_KEY?: string;
  IMAGE_MODEL?: string;
  IMAGE_QUALITY?: string;
  AI_MAX_IMAGES?: string;
  PHOTO_STYLE?: string; // cutout | ai_studio | ai_model | original
  KEEP_ORIGINAL_PHOTOS?: string;

  // Доступ
  ADMIN_TELEGRAM_ID?: string;
  ALLOWED_USERS?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;

  // Тексты
  CLAUDE_MODEL?: string;
  DESCRIPTION_FOOTER?: string;
  PRICE_RULES?: string;

  // Авито
  PUBLISH_MODE?: string; // manual | autoload
  AVITO_CLIENT_ID?: string;
  AVITO_CLIENT_SECRET?: string;
  AVITO_ADDRESS?: string;
  AVITO_PHONE?: string;
  AVITO_LISTING_FEE?: string;
}

export const DEFAULT_FOOTER =
  "Все вещи оригинальные.\nОтправлю Авито Доставкой в день оплаты.\nЗадавайте вопросы в сообщениях — пришлю замеры.";

export function setting(env: Env, key: keyof Env, fallback = ""): string {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim().replace(/\\n/g, "\n") : fallback;
}

export const isAutoload = (env: Env) => setting(env, "PUBLISH_MODE", "manual").toLowerCase() === "autoload";
export const hasImages = (env: Env) => Boolean(setting(env, "OPENAI_API_KEY"));
export const hasClaude = (env: Env) => Boolean(setting(env, "ANTHROPIC_API_KEY"));
export const DEFAULT_TEXT_MODEL = "@cf/mistralai/mistral-small-3.1-24b-instruct";
export const FALLBACK_TEXT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
