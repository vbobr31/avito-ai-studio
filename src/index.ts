interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ADMIN_TELEGRAM_ID?: string;
}
type Button = { text: string; callback_data: string };
type Message = { chat: { id: number }; from?: { id: number }; text?: string };
type Callback = { id: string; from: { id: number }; message?: Message; data?: string };
type Update = { update_id: number; message?: Message; callback_query?: Callback };
const menu: Button[][] = [
  [{ text: "📸 Новое объявление", callback_data: "new" }],
  [{ text: "📋 Мои объявления", callback_data: "list" }],
  [{ text: "💬 Ответ покупателю", callback_data: "reply" }],
  [{ text: "🔗 Подключить Авито", callback_data: "avito" }],
  [{ text: "⚙️ Настройки", callback_data: "settings" }]
];
const welcome = "👋 Добро пожаловать в Avito AI Studio!\n\nЯ помощник для подготовки объявлений на Авито: карточки одежды, студийные фото, ответы покупателям и управление объявлениями.\n\n⚠️ Сейчас запущена стартовая версия. Генерация фото, ИИ-ответы, синхронизация с Авито и публикация будут подключены отдельно. Ничего на Авито автоматически не отправляется.\n\nВыбери действие 👇";
async function api(env: Env, method: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`Telegram ${method}: ${response.status}`);
}
async function send(env: Env, chatId: number, text: string, buttons?: Button[][]) {
  await api(env, "sendMessage", {chat_id: chatId, text, ...(buttons ? {reply_markup:{inline_keyboard:buttons}} : {})});
}
async function handle(env: Env, update: Update) {
  const callback = update.callback_query;
  const msg = update.message ?? callback?.message;
  const uid = update.message?.from?.id ?? callback?.from.id;
  if (!msg || !uid) return;
  if (callback) await api(env, "answerCallbackQuery", {callback_query_id:callback.id});
  const adminId = Number(env.ADMIN_TELEGRAM_ID);
  if (!env.ADMIN_TELEGRAM_ID || !Number.isSafeInteger(adminId) || adminId <= 0) {
    await send(env, msg.chat.id, `🔐 Для запуска укажи ADMIN_TELEGRAM_ID в Cloudflare Secrets. Твой Telegram ID: ${uid}. Не сообщай токены в чат.`);
    return;
  }
  if (uid !== adminId) {
    await send(env, msg.chat.id, "⛔ Этот бот настроен для личного использования.");
    return;
  }
  const action = callback?.data ?? update.message?.text?.trim() ?? "";
  if (action === "/start" || action === "/menu" || action === "menu") {
    await send(env, msg.chat.id, welcome, menu); return;
  }
  const back: Button[][] = [[{text:"⬅️ Главное меню",callback_data:"menu"}]];
  switch(action) {
    case "new":
      await send(env,msg.chat.id,"📸 Новое объявление\n\nВ следующем этапе здесь появятся загрузка фотографий товара, выбор ИИ-модели или собственного фото, новая студия для каждого объявления и согласование готовой карточки. Сейчас создание объявлений ещё не активно.",back);break;
    case "list":
      await send(env,msg.chat.id,"📋 Мои объявления\n\nПодключение к базе и API Авито ещё не завершено. Статусы, сообщения и счётчики пока недоступны — реальные данные не подменяются демонстрационными.",back);break;
    case "reply":
      await send(env,msg.chat.id,"💬 Ответ покупателю\n\nПо согласованным правилам: автоответы на простые вопросы включены; самостоятельные скидки запрещены; уведомления обо всех сообщениях. Для реальной работы нужно подключить Avito Messenger API и ИИ.",back);break;
    case "avito":
      await send(env,msg.chat.id,"🔗 Подключение Авито\n\nАвторизацию аккаунта подключим только через официальные методы Авито после проверки доступности API. Не отправляй логин, пароль и SMS-коды боту.",back);break;
    case "settings":
      await send(env,msg.chat.id,"⚙️ Настройки\n\n✅ Автоответы на простые вопросы: включены (после подключения API)\n🚫 Самостоятельные скидки: запрещены\n🔔 Уведомления: обо всех сообщениях\n\nЭто запланированные настройки; интеграция пока не запущена.",back);break;
    default:
      await send(env,msg.chat.id,"Используй /start, чтобы открыть главное меню.",menu);
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response("Avito AI Studio Worker: online", {status:200});
    if (request.method !== "POST" || url.pathname !== "/telegram") return new Response("Not found",{status:404});
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) return new Response("Not configured",{status:503});
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET)
      return new Response("Forbidden",{status:403});
    try {
      const update = await request.json() as Update;
      await handle(env, update);
      return new Response("OK");
    } catch (error) {
      console.error("Telegram update failed",error);
      return new Response("Processing failed",{status:500});
    }
  }
} satisfies ExportedHandler<Env>;
