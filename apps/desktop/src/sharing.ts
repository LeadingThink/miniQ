export interface SharedMessage { role: "user" | "assistant"; content: string; createdAt: string }
export interface SharedFile { id: string; name: string; size: number }
export interface ShareLink {
  id: string; title: string; url: string; createdAt: string; expiresAt: string;
  published: boolean; messageCount: number; files: SharedFile[];
}
export interface SharePage extends Omit<ShareLink, "url"> { messages: SharedMessage[]; nextPage: number | null }

export function sharedSessionId(search = window.location.search): string | null {
  const value = new URLSearchParams(search).get("share");
  return value === null ? null : /^[a-f0-9]{32}$/.test(value) ? value : "invalid";
}

export function shareApi(id: string): string {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("分享链接无效");
  return `/miniq-relay/shares/${id}`;
}

export function sharedFileUrl(id: string, file: SharedFile) {
  if (!/^[a-f0-9]{32}$/.test(file.id)) throw new Error("分享文件无效");
  return `${shareApi(id)}/files/${file.id}`;
}

export async function loadShare(id: string, page: number, signal: AbortSignal): Promise<SharePage> {
  const response = await fetch(`${shareApi(id)}?page=${page}`, { signal, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
  if (response.status === 404) throw new Error("此分享不存在、已撤销或已到期。");
  if (!response.ok) throw new Error("暂时无法加载分享，请重试。");
  const value = await response.json() as SharePage;
  if (!value || value.id !== id || typeof value.title !== "string" || !Array.isArray(value.messages) || !Array.isArray(value.files) ||
      value.published !== true || !Number.isSafeInteger(value.messageCount) || value.messageCount < 1 ||
      !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.expiresAt)) ||
      !value.messages.every((message) => message && ["user", "assistant"].includes(message.role) && typeof message.content === "string") ||
      !value.files.every((file) => file && /^[a-f0-9]{32}$/.test(file.id) && typeof file.name === "string" && Number.isSafeInteger(file.size) && file.size >= 0) ||
      (value.nextPage !== null && value.nextPage !== page + 1)) throw new Error("分享内容格式无效。");
  return value;
}
