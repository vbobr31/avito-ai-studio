/** Авито: файл выгрузки (XML-фид) и API Автозагрузки. */
import type { Env } from "./env";
import { DEFAULT_FOOTER, setting } from "./env";
import { AD_TYPE, CATEGORY, DESCRIPTION_MAX, Listing, MAX_IMAGES, TITLE_MAX } from "./fields";

const API = "https://api.avito.ru";

export function fullDescription(listing: Listing, env: Env): string {
  const footer = setting(env, "DESCRIPTION_FOOTER", DEFAULT_FOOTER);
  const text = [listing.description.trim(), footer.trim()].filter(Boolean).join("\n\n");
  return text.slice(0, DESCRIPTION_MAX);
}

const xmlEsc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function descriptionHtml(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => "<p>" + p.split("\n").map((l) => xmlEsc(l.trim())).filter(Boolean).join("<br>") + "</p>")
    .join("")
    .replace(/]]>/g, "]] >");
}

const tag = (name: string, value: unknown) =>
  value === undefined || value === null || value === "" ? "" : `    <${name}>${xmlEsc(value)}</${name}>\n`;

export interface FeedItem { id: string; listing: Listing; photoUrls: string[] }

export function buildFeed(items: FeedItem[], env: Env): string {
  const ads = items
    .map((it) => {
      const l = it.listing;
      const images = it.photoUrls.slice(0, MAX_IMAGES).map((u) => `      <Image url="${xmlEsc(u)}"/>\n`).join("");
      return (
        "  <Ad>\n" +
        tag("Id", it.id) +
        tag("ListingFee", setting(env, "AVITO_LISTING_FEE")) +
        tag("AdStatus", "Free") +
        tag("ContactPhone", setting(env, "AVITO_PHONE")) +
        tag("Address", setting(env, "AVITO_ADDRESS")) +
        tag("Category", CATEGORY) +
        tag("GoodsType", l.goods_type) +
        tag("AdType", AD_TYPE) +
        tag("Apparel", l.apparel) +
        tag("Size", l.size) +
        tag("Condition", l.condition) +
        tag("Brand", l.brand) +
        tag("Color", l.color) +
        tag("Title", l.title.slice(0, TITLE_MAX)) +
        `    <Description><![CDATA[${descriptionHtml(fullDescription(l, env))}]]></Description>\n` +
        tag("Price", Math.round(l.price) || "") +
        (images ? `    <Images>\n${images}    </Images>\n` : "") +
        "  </Ad>\n"
      );
    })
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>\n<Ads formatVersion="3" target="Avito.ru">\n${ads}</Ads>\n`;
}

export interface AvitoItemStatus {
  ad_id: string;
  avito_id?: number | null;
  avito_status?: string | null;
  url?: string | null;
  section?: { slug?: string; title?: string };
  messages?: { type?: string; title?: string; description?: string }[];
}

export class Avito {
  private token = "";
  private tokenUntil = 0;
  constructor(private env: Env) {}

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenUntil - 60_000) return this.token;
    const res = await fetch(`${API}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: setting(this.env, "AVITO_CLIENT_ID"),
        client_secret: setting(this.env, "AVITO_CLIENT_SECRET"),
      }),
    });
    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!res.ok || !data.access_token) throw new Error(`Токен Авито: ${res.status} ${JSON.stringify(data)}`);
    this.token = data.access_token;
    this.tokenUntil = Date.now() + (data.expires_in ?? 3600) * 1000;
    return this.token;
  }

  private async request<T>(method: string, path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(API + path);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${await this.getToken()}` } });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Запускает загрузку по ссылке из настроек Автозагрузки. Не чаще раза в час. */
  triggerUpload(): Promise<unknown> {
    return this.request("POST", "/autoload/v1/upload");
  }

  async itemStatus(adId: string): Promise<AvitoItemStatus | null> {
    for (const path of ["/autoload/v4/uploads/current/items", "/autoload/v4/uploads/last_successful/items"]) {
      try {
        const data = await this.request<{ items?: AvitoItemStatus[] }>("GET", path, { query: adId });
        const found = data.items?.find((i) => i.ad_id === adId);
        if (found) return found;
      } catch (e) {
        console.warn("Статус Авито", adId, String(e));
      }
    }
    return null;
  }
}

export function describeStatus(s: AvitoItemStatus): string {
  const msgs = s.messages ?? [];
  if (!msgs.length) return s.section?.title ?? "";
  return msgs.map((m) => `• ${[m.title, m.description].filter(Boolean).join(": ")}`).join("\n");
}
