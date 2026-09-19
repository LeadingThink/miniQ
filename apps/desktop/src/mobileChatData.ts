export const MOBILE_API_BASE_URL = "https://oneapi.zaiwenai.com/v1";
export const MOBILE_CHAT_STORAGE_KEY = "miniq.mobile.chat.v1";
export const MOBILE_MODEL_STORAGE_KEY = "miniq.mobile.chat.model.v1";

export type ChatContent = string | Array<
  { type: "text"; text: string } |
  { type: "image_url"; image_url: { url: string; detail?: "auto" } }
>;

export interface MobileChatMessage {
  role: "user" | "assistant";
  content: ChatContent;
  status?: "failed" | "interrupted";
}

export interface PendingMobileImage {
  name: string;
  dataUrl: string;
}

export function textChatModels(result: unknown): string[] {
  if (!result || typeof result !== "object" || !("data" in result) || !Array.isArray(result.data)) {
    throw new Error("模型列表格式无效，请重新加载");
  }
  return [...new Set(result.data.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || !("model_type" in item) || item.model_type !== "chat") return [];
    return "id" in item && typeof item.id === "string" && item.id.trim() ? [item.id] : [];
  }))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export function readMobileChat(): MobileChatMessage[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(MOBILE_CHAT_STORAGE_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter(isChatMessage) : [];
  } catch {
    return [];
  }
}

function isChatMessage(value: unknown): value is MobileChatMessage {
  if (!value || typeof value !== "object" || !("role" in value) || !("content" in value)) return false;
  if (value.role !== "user" && value.role !== "assistant") return false;
  if ("status" in value && value.status !== "failed" && value.status !== "interrupted") return false;
  return typeof value.content === "string" || (Array.isArray(value.content) && value.content.every((part: unknown) => {
    if (!part || typeof part !== "object" || !("type" in part)) return false;
    if (part.type === "text") return "text" in part && typeof part.text === "string";
    if (part.type !== "image_url" || !("image_url" in part)) return false;
    const image = part.image_url;
    return Boolean(image && typeof image === "object" && "url" in image && typeof image.url === "string"
      && /^(https?:\/\/|data:image\/(?:png|jpeg|webp|gif);base64,)/i.test(image.url));
  }));
}

export function persistMobileChat(messages: MobileChatMessage[]): boolean {
  try {
    localStorage.setItem(MOBILE_CHAT_STORAGE_KEY, JSON.stringify(messages));
    return true;
  } catch {
    return false;
  }
}

export async function mobileResponseError(response: Response): Promise<string> {
  try {
    const value = await response.json() as { error?: { message?: string } };
    return value.error?.message ?? `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

export async function readMobileImage(file: File): Promise<PendingMobileImage> {
  if (file.size > 20 * 1024 * 1024) throw new Error("图片不能超过 20 MB");
  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) throw new Error("仅支持 PNG、JPEG、WebP 或 GIF 图片");
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("图片读取失败"));
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
  return { name: file.name, dataUrl };
}
