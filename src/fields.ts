/**
 * Поля категории Авито «Одежда, обувь, аксессуары» для Автозагрузки.
 * Авито иногда меняет шаблоны — сверяйте с https://www.avito.ru/autoload/documentation/templates
 */
export const CATEGORY = "Одежда, обувь, аксессуары";
export const AD_TYPE = "Товар приобретен на продажу";

export const GOODS_TYPES = ["Женская одежда", "Мужская одежда", "Сумки, рюкзаки и чемоданы", "Аксессуары"];

export const APPAREL: Record<string, string[]> = {
  "Женская одежда": [
    "Брюки", "Верхняя одежда", "Джинсы", "Купальники", "Нижнее бельё", "Обувь", "Пиджаки и костюмы",
    "Платья", "Рубашки и блузки", "Топы и футболки", "Трикотаж", "Шорты", "Юбки", "Другое",
  ],
  "Мужская одежда": [
    "Брюки", "Верхняя одежда", "Джинсы", "Нижнее бельё", "Обувь", "Пиджаки и костюмы", "Рубашки",
    "Трикотаж и футболки", "Шорты", "Другое",
  ],
};

export const CONDITIONS = ["Новое с биркой", "Отличное", "Хорошее", "Удовлетворительное"];

export const TITLE_MAX = 50;
export const DESCRIPTION_MAX = 7500;
export const MAX_IMAGES = 10;

export interface Listing {
  title: string;
  description: string;
  price: number;
  price_comment?: string;
  goods_type: string;
  apparel: string;
  size: string;
  condition: string;
  brand: string;
  color: string;
  item_summary?: string;
}

export const EDITABLE: Record<string, string> = {
  title: "Заголовок",
  description: "Описание",
  price: "Цена",
  photos: "Фото",
  condition: "Состояние",
  size: "Размер",
  brand: "Бренд",
  color: "Цвет",
  apparel: "Вид вещи",
  goods_type: "Раздел",
};

export function normalize(input: Partial<Listing>): Listing {
  let title = String(input.title ?? "").trim();
  if (title.length > TITLE_MAX) {
    const cut = title.slice(0, TITLE_MAX + 1);
    title = (cut.lastIndexOf(" ") > 20 ? cut.slice(0, cut.lastIndexOf(" ")) : cut).replace(/[ ,.\-]+$/, "");
  }
  const goodsType = GOODS_TYPES.includes(String(input.goods_type)) ? String(input.goods_type) : GOODS_TYPES[0];
  const price = Math.round((Number(input.price) || 0) / 100) * 100;
  return {
    title: title.slice(0, TITLE_MAX),
    description: String(input.description ?? "").trim(),
    price,
    price_comment: input.price_comment ? String(input.price_comment) : "",
    goods_type: goodsType,
    apparel: APPAREL[goodsType] ? String(input.apparel ?? "") : "",
    size: String(input.size ?? ""),
    condition: CONDITIONS.includes(String(input.condition)) ? String(input.condition) : "Хорошее",
    brand: String(input.brand ?? ""),
    color: String(input.color ?? ""),
    item_summary: input.item_summary ? String(input.item_summary) : "",
  };
}
