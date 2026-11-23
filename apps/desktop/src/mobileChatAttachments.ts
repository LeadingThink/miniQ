import { imageTooLarge, MAX_IMAGE_BYTES } from "./imageLimits";
import type { ChatContent } from "./mobileChatData";

export const MAX_MOBILE_VIDEO_BYTES = 64 * 1024 * 1024;
export const MAX_MOBILE_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_MOBILE_TEXT_BYTES = 1024 * 1024;
export const MOBILE_CHAT_MEDIA_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm";

export type PendingMobileAttachment = { name: string } & (
  { kind: "image" | "video" | "pdf"; dataUrl: string } | { kind: "text"; text: string }
);

export async function readMobileAttachment(file: File): Promise<PendingMobileAttachment> {
  const { type, kind } = validateMobileAttachment(file);
  const result = await new Promise<string | ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => reader.result === null ? reject(new Error("附件读取失败")) : resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error("附件读取失败"));
    reader.onabort = () => reject(new Error("附件读取已取消"));
    if (kind === "text") reader.readAsArrayBuffer(file);
    else reader.readAsDataURL(new Blob([file], { type }));
  });
  if (kind === "text" && result instanceof ArrayBuffer) {
    return { kind, name: file.name, text: decodeDocumentText(result) };
  }
  if (kind !== "text" && typeof result === "string") return { kind, name: file.name, dataUrl: result };
  throw new Error("附件读取失败");
}

export function validateMobileAttachment(file: Pick<File, "type" | "name" | "size">): { type: string; kind: PendingMobileAttachment["kind"] } {
  const type = mobileAttachmentType(file);
  if (!type) throw new Error("独立问答仅支持照片、视频、PDF 和文本文件；其他微信文件请转为 PDF 或连接桌面上传");
  const kind = type.startsWith("video/") ? "video" : type.startsWith("image/") ? "image" : type === "application/pdf" ? "pdf" : "text";
  if (!Number.isSafeInteger(file.size) || file.size < 1) throw new Error("所选文件为空，请重新选择");
  if (kind === "image" && file.size > MAX_IMAGE_BYTES) throw imageTooLarge();
  if (kind === "video" && file.size > MAX_MOBILE_VIDEO_BYTES) throw new Error("视频不能超过 64 MiB");
  if (kind === "pdf" && file.size > MAX_MOBILE_DOCUMENT_BYTES) throw new Error("PDF 文件不能超过 20 MiB");
  if (kind === "text" && file.size > MAX_MOBILE_TEXT_BYTES) throw new Error("文本文件不能超过 1 MiB");
  return { type, kind };
}

function mobileAttachmentType(file: Pick<File, "type" | "name">): string | null {
  const type = file.type.toLowerCase();
  if (/^image\/(png|jpeg|webp|gif)$|^video\/(mp4|quicktime|webm)$/.test(type)) return type;
  if (type === "video/x-m4v") return "video/mp4";
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  if (extension === "pdf" && (type === "application/pdf" || !type || type === "application/octet-stream")) return "application/pdf";
  if (/^(txt|md|markdown|csv|tsv|json|log|yaml|yml|xml)$/.test(extension)
    && (!type || type === "application/octet-stream" || type.startsWith("text/") || /^application\/(json|xml|yaml)$/.test(type))) return "text/plain";
  if (type && type !== "application/octet-stream") return null;
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
    mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" } as Record<string, string>)[extension] ?? null;
}

function decodeDocumentText(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (text.includes("\u0000")) throw new Error("binary text");
    return text;
  } catch {
    throw new Error("文本编码无效，请将文件保存为 UTF-8 或带 BOM 的 UTF-16 后重试");
  }
}

export function mobileAttachmentContent(text: string, attachment: PendingMobileAttachment | null): ChatContent {
  if (!attachment) return text;
  const parts: Exclude<ChatContent, string> = text ? [{ type: "text", text }] : [];
  if (attachment.kind === "text") parts.push({ type: "text", text: `附件：${attachment.name}\n${attachment.text}` });
  else if (attachment.kind === "pdf") parts.push({ type: "file", file: { filename: attachment.name, file_data: attachment.dataUrl } });
  else if (attachment.kind === "video") parts.push({ type: "video_url", video_url: { url: attachment.dataUrl } });
  else parts.push({ type: "image_url", image_url: { url: attachment.dataUrl, detail: "auto" } });
  return parts;
}
