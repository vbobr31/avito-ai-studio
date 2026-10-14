/**
 * Фото нейросетью OpenAI (метод images/edits): пустая студия + вещь → вещь в студии или на модели.
 * Это графика: детали могут чуть отличаться от реальных, поэтому к объявлению добавляются исходные фото.
 */
import type { Env } from "./env";
import { setting } from "./env";
import type { Img } from "./ai";
import { fromBase64, imageSize, toBase64 } from "./util";

const URL = "https://api.openai.com/v1/images/edits";

const KEEP =
  "Keep the garment exactly as in image 2: same colour and shade, print, pattern, logos, labels, texture, " +
  "stitching, buttons, zippers, length and cut. Do not redesign, recolour or simplify it, do not add or remove " +
  "details. No text, no watermarks, no extra products.";

export const PROMPTS: Record<string, string[]> = {
  ai_studio: [
    "Image 1 is an empty photo studio. Image 2 is a clothing item. Create a realistic professional product photo " +
      "for a marketplace listing: this exact item on a simple hanger, placed in this studio, front view, centred, " +
      "the whole item visible. Keep the studio background, colours and light from image 1, add natural soft shadows. " + KEEP,
    "Image 1 is an empty photo studio. Image 2 is a clothing item. Create a realistic professional product photo: " +
      "this exact item displayed on a neutral dress form (ghost mannequin style) in this studio, three-quarter view, " +
      "the whole item visible. Keep the background and light from image 1. " + KEEP,
    "Image 1 is an empty photo studio. Image 2 is a clothing item. Create a realistic close-up product photo of this " +
      "exact item in this studio that shows the fabric texture and main details. Keep the background and light from image 1. " + KEEP,
  ],
  ai_model: [
    "Image 1 is an empty photo studio. Image 2 is a clothing item. Create a realistic fashion e-commerce photo: an adult " +
      "model wearing this exact item in this studio, full length, neutral pose, calm natural face, simple neutral styling " +
      "for the other clothes. Keep the background and light from image 1. " + KEEP,
    "Image 1 is an empty photo studio. Image 2 is a clothing item. Create a realistic fashion e-commerce photo: an adult " +
      "model wearing this exact item in this studio, three-quarter view, showing the fit and silhouette. Keep the " +
      "background and light from image 1. " + KEEP,
    "Image 1 is an empty photo studio. Image 2 is a clothing item. Create a realistic close-up e-commerce photo of an adult " +
      "model wearing this exact item in this studio, framed on the garment to show fabric and details. Keep the background " +
      "and light from image 1. " + KEEP,
  ],
};

function sizeFor(studio: Img): string {
  const s = imageSize(studio.data);
  if (!s) return "1024x1536";
  if (s.height > s.width * 1.15) return "1024x1536";
  if (s.width > s.height * 1.15) return "1536x1024";
  return "1024x1024";
}

async function readError(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: { message?: string } };
    return `${res.status}: ${data.error?.message ?? "ошибка"}`;
  } catch {
    return String(res.status);
  }
}

export async function generateImage(env: Env, studio: Img, product: Img, style: string, n: number): Promise<ArrayBuffer> {
  const prompts = PROMPTS[style] ?? PROMPTS.ai_studio;
  const prompt = prompts[n % prompts.length];
  const model = setting(env, "IMAGE_MODEL", "gpt-image-2.5-sunburst");
  const quality = setting(env, "IMAGE_QUALITY", "high");
  const size = sizeFor(studio);
  const headers = { Authorization: `Bearer ${setting(env, "OPENAI_API_KEY")}` };
  const images = [studio, product];

  let res = await fetch(URL, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      images: images.map((i) => ({ image_url: `data:${i.mime};base64,${toBase64(i.data)}` })),
      size,
      quality,
      output_format: "jpeg",
      output_compression: 85,
    }),
  });

  if (res.status === 400) {
    // Старый формат запроса (multipart, поле image[]) — на случай, если JSON не принят
    const first = await readError(res);
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", prompt);
    form.append("size", size);
    form.append("quality", quality);
    form.append("output_format", "jpeg");
    images.forEach((i, k) => form.append("image[]", new Blob([i.data], { type: i.mime }), `in${k}.jpg`));
    res = await fetch(URL, { method: "POST", headers, body: form });
    if (!res.ok) throw new Error(`${await readError(res)} (до этого: ${first})`);
  } else if (!res.ok) {
    throw new Error(await readError(res));
  }

  const data = (await res.json()) as { data?: { b64_json?: string }[] };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("нейросеть не вернула картинку");
  const bytes = fromBase64(b64);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
