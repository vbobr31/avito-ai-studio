/** Оформление бота: название, описание, приветствие, меню, аватарка. */
import type { Env } from "./env";
import { hasImages } from "./env";
import { AVATAR_JPEG_BASE64 } from "./avatar";
import { Telegram } from "./telegram";
import { fromBase64 } from "./util";

export const BOT_NAME = "Avito AI Studio";

/** Видно в профиле бота (до 120 символов). */
export const SHORT_DESCRIPTION =
  "ИИ-фотостудия и помощник для Авито: фото одежды в студии, описание, цена и готовое объявление.";

/** Видно в пустом чате до нажатия «Старт» (до 512 символов). */
export const DESCRIPTION =
  "ИИ-фотостудия и помощник для продажи одежды на Авито.\n\n" +
  "📸 Поставлю вашу вещь в фотостудию\n" +
  "✨ Напишу заголовок и описание\n" +
  "💰 Предложу цену\n" +
  "📦 Подготовлю объявление к публикации\n\n" +
  "Перед публикацией всегда покажу карточку на согласование. Нажмите «Старт».";

/** Кнопки главного меню внизу чата. */
export const MENU = {
  NEW: "📸 Новое объявление",
  LIST: "📋 Мои объявления",
  STUDIOS: "📍 Локации студии",
  HELP: "❓ Помощь",
} as const;

export const MENU_KEYBOARD = {
  keyboard: [[{ text: MENU.NEW }], [{ text: MENU.LIST }, { text: MENU.STUDIOS }], [{ text: MENU.HELP }]],
  resize_keyboard: true,
  is_persistent: true,
};

export function welcomeText(env: Env): string {
  return (
    "👋 <b>Добро пожаловать в Avito AI Studio!</b>\n\n" +
    "Я ваш ИИ-помощник по продаже одежды на Авито.\n\n" +
    "📸 Поставлю вещь в вашу фотостудию — на фото выбранной локации.\n" +
    (hasImages(env) ? "👕 Покажу одежду на ИИ-модели.\n" : "") +
    "✨ Подготовлю заголовок и описание.\n" +
    "💰 Помогу определить цену.\n" +
    "✏️ Всё поправим кнопками: переделаю сам или введёте своё.\n" +
    "📦 Подготовлю объявление к публикации.\n\n" +
    "Вы контролируете результат: перед публикацией я обязательно покажу карточку на согласование.\n\n" +
    "Выберите действие в меню ниже 👇"
  );
}

export const HELP_TEXT =
  "<b>Как это работает</b>\n" +
  "1. «📸 Новое объявление» → фото пустой студии (или выбор сохранённой локации).\n" +
  "2. Фото вещи — можно альбомом, потом «Готово».\n" +
  "3. Фото бирки или «Пропустить».\n" +
  "4. Одним сообщением: название, бренд, размер.\n" +
  "5. Проверяете карточку → «Всё устраивает» или «Нет, изменить».\n\n" +
  "<b>Команды</b>\n/new — новая вещь\n/list — мои объявления\n/studios — локации студии\n" +
  "/feed — ссылка на фид для Авито\n/cancel — отменить текущую вещь\n/adduser ID — дать доступ коллеге\n/id — мой Telegram ID";

/** Ставит название, описания, команды и аватарку. Возвращает строки отчёта. */
export async function applyProfile(tg: Telegram): Promise<string[]> {
  const report: string[] = [];
  const step = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      report.push(`✅ ${label}`);
    } catch (e) {
      report.push(`⚠️ ${label}: ${String(e)}`);
    }
  };

  await step("Название", async () => {
    const current = await tg.call<{ name: string }>("getMyName");
    if (current.name !== BOT_NAME) await tg.call("setMyName", { name: BOT_NAME });
  });
  await step("Описание профиля", () => tg.call("setMyShortDescription", { short_description: SHORT_DESCRIPTION }));
  await step("Приветствие до «Старт»", () => tg.call("setMyDescription", { description: DESCRIPTION }));
  await step("Команды меню", () =>
    tg.call("setMyCommands", {
      commands: [
        { command: "start", description: "Главное меню" },
        { command: "new", description: "Новое объявление" },
        { command: "list", description: "Мои объявления" },
        { command: "studios", description: "Локации студии" },
        { command: "cancel", description: "Отменить текущую вещь" },
        { command: "help", description: "Помощь" },
      ],
    }),
  );
  await step("Аватарка", async () => {
    const bytes = fromBase64(AVATAR_JPEG_BASE64);
    const form = new FormData();
    form.append("photo", JSON.stringify({ type: "static", photo: "attach://avatar" }));
    form.append("avatar", new Blob([bytes.buffer as ArrayBuffer], { type: "image/jpeg" }), "avatar.jpg");
    await tg.callForm("setMyProfilePhoto", form);
  });
  return report;
}
