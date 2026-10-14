import type { BotDO } from "./bot";

/** Все настройки задаются в Cloudflare → Worker → Settings → Variables and Secrets (тип Secret). */
export interface Env {
  BOT: DurableObjectNamespace<BotDO>;

  // Обязательно
  TELEGRAM_BOT_TOKEN: string;
  ANTHROPIC_API_KEY?: string;

  // Картинки нейросетью
  OPENAI_API_KEY?: string;
  IMAGE_MODEL?: string;
  IMAGE_QUALITY?: string;
  AI_MAX_IMAGES?: string;
  PHOTO_STYLE?: string; // ai_studio | ai_model | original
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
