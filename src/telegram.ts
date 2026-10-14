export type Button = { text: string; callback_data: string };
export type Keyboard = Button[][];

export interface TgPhotoSize { file_id: string; file_unique_id: string; file_size?: number; width: number; height: number }
export interface TgDocument { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number }
export interface TgMessage {
  message_id: number;
  chat: { id: number };
  from?: { id: number; first_name?: string };
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
  media_group_id?: string;
}
export interface TgCallback { id: string; from: { id: number }; message?: TgMessage; data?: string }
export interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallback }

export interface FileToSend { data: ArrayBuffer; name: string; mime: string }

export class TelegramError extends Error {}

export class Telegram {
  constructor(private token: string) {}

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  async call<T = unknown>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.url(method), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new TelegramError(`${method}: ${data.description ?? res.status}`);
    return data.result;
  }

  async callForm<T = unknown>(method: string, form: FormData): Promise<T> {
    const res = await fetch(this.url(method), { method: "POST", body: form });
    const data = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!data.ok) throw new TelegramError(`${method}: ${data.description ?? res.status}`);
    return data.result;
  }

  send(chatId: number, text: string, keyboard?: Keyboard, extra: Record<string, unknown> = {}): Promise<TgMessage> {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
      ...extra,
    });
  }

  async answer(callbackId: string, text?: string): Promise<void> {
    try {
      await this.call("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
    } catch {
      /* кнопка могла устареть — не страшно */
    }
  }

  async removeKeyboard(chatId: number, messageId: number): Promise<void> {
    try {
      await this.call("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
    } catch {
      /* уже без кнопок */
    }
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    try {
      await this.call("deleteMessage", { chat_id: chatId, message_id: messageId });
    } catch {
      /* ничего */
    }
  }

  async download(fileId: string): Promise<{ data: ArrayBuffer; path: string }> {
    const file = await this.call<{ file_path?: string }>("getFile", { file_id: fileId });
    if (!file.file_path) throw new TelegramError("Telegram не отдал файл");
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new TelegramError(`Скачивание файла: ${res.status}`);
    return { data: await res.arrayBuffer(), path: file.file_path };
  }

  /** Фото или файлы альбомом (2–10), одно — отдельным сообщением. */
  async sendFiles(chatId: number, files: FileToSend[], asDocuments = false, caption?: string): Promise<void> {
    const list = files.slice(0, 10);
    if (!list.length) return;
    const type = asDocuments ? "document" : "photo";
    const form = new FormData();
    form.append("chat_id", String(chatId));
    if (list.length === 1) {
      const f = list[0];
      form.append(type, new Blob([f.data], { type: f.mime }), f.name);
      if (caption) {
        form.append("caption", caption);
        form.append("parse_mode", "HTML");
      }
      await this.callForm(asDocuments ? "sendDocument" : "sendPhoto", form);
      return;
    }
    const media = list.map((f, i) => ({
      type,
      media: `attach://f${i}`,
      ...(i === 0 && caption ? { caption, parse_mode: "HTML" } : {}),
    }));
    form.append("media", JSON.stringify(media));
    list.forEach((f, i) => form.append(`f${i}`, new Blob([f.data], { type: f.mime }), f.name));
    await this.callForm("sendMediaGroup", form);
  }
}
