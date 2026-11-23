export const MOBILE_CHAT_STORAGE_KEY = "miniq.mobile.chat.v1";
export const MOBILE_MODEL_STORAGE_KEY = "miniq.mobile.chat.model.v1";

export type ChatContent = string | Array<
  { type: "text"; text: string } |
  { type: "image_url"; image_url: { url: string; detail?: "auto" } } |
  { type: "video_url"; video_url: { url: string } } |
  { type: "file"; file: { filename: string; file_data: string } }
>;

export interface MobileChatMessage {
  id: string;
  role: "user" | "assistant";
  content: ChatContent;
  reasoning?: string;
  replyTo?: string;
  status?: "failed" | "interrupted";
  createdAt?: string;
  completedAt?: string;
  elapsedMs?: number;
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
    if (!Array.isArray(value)) return [];
    const messages: MobileChatMessage[] = [];
    const ids = new Set<string>();
    for (const item of value.filter(isChatMessage)) {
      const id = typeof item.id === "string" && item.id && !ids.has(item.id) ? item.id : crypto.randomUUID();
      const previous = messages.at(-1);
      const replyTo = item.role === "assistant"
        ? typeof item.replyTo === "string" ? item.replyTo : previous?.role === "user" ? previous.id : undefined
        : undefined;
      messages.push({ id, role: item.role, content: item.content,
        ...(item.role === "assistant" && typeof item.reasoning === "string" ? { reasoning: item.reasoning } : {}),
        ...(item.status ? { status: item.status } : {}), ...(replyTo ? { replyTo } : {}),
        ...(validTimestamp(item.createdAt) ? { createdAt: item.createdAt } : {}),
        ...(validTimestamp(item.completedAt) ? { completedAt: item.completedAt } : {}),
        ...(typeof item.elapsedMs === "number" && Number.isFinite(item.elapsedMs) && item.elapsedMs >= 0
          ? { elapsedMs: item.elapsedMs } : {}),
      });
      ids.add(id);
    }
    return messages;
  } catch {
    return [];
  }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isChatMessage(value: unknown): value is Omit<MobileChatMessage, "id"> & { id?: string } {
  if (!value || typeof value !== "object" || !("role" in value) || !("content" in value)) return false;
  if (value.role !== "user" && value.role !== "assistant") return false;
  if ("status" in value && value.status !== "failed" && value.status !== "interrupted") return false;
  return typeof value.content === "string" || (Array.isArray(value.content) && value.content.every((part: unknown) => {
    if (!part || typeof part !== "object" || !("type" in part)) return false;
    if (part.type === "text") return "text" in part && typeof part.text === "string";
    if (part.type === "file") {
      const file = "file" in part ? part.file : null;
      return Boolean(file && typeof file === "object" && "filename" in file && typeof file.filename === "string"
        && file.filename.trim() && "file_data" in file && typeof file.file_data === "string"
        && /^data:application\/pdf;base64,[A-Za-z0-9+/]+={0,2}$/.test(file.file_data));
    }
    const media = part.type === "image_url" && "image_url" in part ? part.image_url
      : part.type === "video_url" && "video_url" in part ? part.video_url : null;
    if (!media || typeof media !== "object" || !("url" in media) || typeof media.url !== "string") return false;
    return part.type === "image_url"
      ? /^(https?:\/\/|data:image\/(?:png|jpeg|webp|gif);base64,)/i.test(media.url)
      : /^(https?:\/\/|data:video\/(?:mp4|quicktime|webm);base64,)/i.test(media.url);
  }));
}

export function mobileMessageText(content: ChatContent): string {
  return typeof content === "string" ? content : content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
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
