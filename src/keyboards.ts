import type { Keyboard } from "./telegram";
import { EDITABLE } from "./fields";

export const studiosKb = (studios: { id: number; name: string }[]): Keyboard => [
  ...studios.slice(0, 20).map((s) => [{ text: `📍 ${s.name}`, callback_data: `st:${s.id}` }]),
  [{ text: "➕ Новая локация (пришлю фото)", callback_data: "st:new" }],
];

export const singleKb = (text: string, data: string): Keyboard => [[{ text, callback_data: data }]];

export const photosDoneKb = (): Keyboard => singleKb("✅ Готово, фото все", "photos_done");

export const reviewKb = (id: string): Keyboard => [
  [{ text: "✅ Всё устраивает", callback_data: `ok:${id}` }],
  [{ text: "✏️ Нет, изменить", callback_data: `edit:${id}` }],
  [{ text: "🗑 Отменить вещь", callback_data: `drop:${id}` }],
];

export function editMenuKb(id: string): Keyboard {
  const buttons = Object.entries(EDITABLE).map(([key, label]) => ({ text: label, callback_data: `ef:${id}:${key}` }));
  const rows: Keyboard = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: "⬅️ Назад к объявлению", callback_data: `show:${id}` }]);
  return rows;
}

export function editModeKb(id: string, field: string, aiImages: boolean): Keyboard {
  const rows: Keyboard = [];
  if (field === "photos") {
    if (aiImages) {
      rows.push([{ text: "🤖 Переделай сам (другой вариант)", callback_data: `em:${id}:photos:auto` }]);
      rows.push([{ text: "🎨 Нейросеть: вещь в студии", callback_data: `sty:${id}:ai_studio` }]);
      rows.push([{ text: "👗 Нейросеть: вещь на модели", callback_data: `sty:${id}:ai_model` }]);
      rows.push([{ text: "📷 Только мои фото, без нейросети", callback_data: `sty:${id}:original` }]);
    }
    rows.push([{ text: "📷 Пришлю новые фото товара", callback_data: `em:${id}:photos:manual` }]);
    rows.push([{ text: "📍 Другая локация студии", callback_data: `em:${id}:photos:studio` }]);
  } else {
    rows.push([{ text: "🤖 Давай я сам переделаю", callback_data: `em:${id}:${field}:auto` }]);
    rows.push([{ text: "⌨️ Введу своё", callback_data: `em:${id}:${field}:manual` }]);
  }
  rows.push([{ text: "⬅️ Назад", callback_data: `edit:${id}` }]);
  return rows;
}

export function optionsKb(id: string, field: string, options: string[]): Keyboard {
  const buttons = options.map((o, i) => ({ text: o, callback_data: `set:${id}:${field}:${i}` }));
  const rows: Keyboard = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  rows.push([{ text: "⬅️ Назад", callback_data: `ef:${id}:${field}` }]);
  return rows;
}

export const confirmPublishKb = (id: string): Keyboard => [
  [{ text: "🚀 Да, публикуем", callback_data: `pub:${id}` }],
  [{ text: "⬅️ Вернуться к правкам", callback_data: `edit:${id}` }],
];

export function listItemKb(id: string, canRemove: boolean, canFix: boolean): Keyboard | undefined {
  const rows: Keyboard = [];
  if (canFix) rows.push([{ text: "✏️ Исправить", callback_data: `show:${id}` }]);
  if (canRemove) rows.push([{ text: "Снять с продажи", callback_data: `rm:${id}` }]);
  return rows.length ? rows : undefined;
}
