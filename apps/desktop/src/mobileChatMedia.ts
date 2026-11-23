import { imageTooLarge, MAX_IMAGE_BYTES } from "./imageLimits";
import type { ChatContent } from "./mobileChatData";

export const MAX_MOBILE_VIDEO_BYTES = 64 * 1024 * 1024;
export const MOBILE_CHAT_MEDIA_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/quicktime,video/webm,.mp4,.m4v,.mov,.webm";

export interface PendingMobileMedia {
  kind: "image" | "video";
  name: string;
  dataUrl: string;
}

export async function readMobileMedia(file: File): Promise<PendingMobileMedia> {
  const { type, kind } = validateMobileMedia(file);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("附件读取失败"));
    reader.onerror = () => reject(reader.error ?? new Error("附件读取失败"));
    reader.onabort = () => reject(new Error("附件读取已取消"));
    // Use a canonical MIME type when the provider only reports a file extension.
    reader.readAsDataURL(new Blob([file], { type }));
  });
  return { kind, name: file.name, dataUrl };
}

export function validateMobileMedia(file: Pick<File, "type" | "name" | "size">): { type: string; kind: PendingMobileMedia["kind"] } {
  const type = mobileMediaType(file);
  if (!type) throw new Error("仅支持 PNG、JPEG、WebP、GIF 图片或 MP4、MOV、WebM 视频");
  const kind = type.startsWith("video/") ? "video" : "image";
  if (kind === "image" && file.size > MAX_IMAGE_BYTES) throw imageTooLarge();
  if (kind === "video" && file.size > MAX_MOBILE_VIDEO_BYTES) throw new Error("视频不能超过 64 MiB");
  if (!Number.isSafeInteger(file.size) || file.size < 1) throw new Error("所选文件为空，请重新选择");
  return { type, kind };
}

function mobileMediaType(file: Pick<File, "type" | "name">): string | null {
  const type = file.type.toLowerCase();
  if (/^image\/(png|jpeg|webp|gif)$|^video\/(mp4|quicktime|webm)$/.test(type)) return type;
  if (type === "video/x-m4v") return "video/mp4";
  if (type && type !== "application/octet-stream") return null;
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
    mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" } as Record<string, string>)[extension] ?? null;
}

export function mobileMediaContent(text: string, media: PendingMobileMedia | null): ChatContent {
  if (!media) return text;
  return [...(text ? [{ type: "text" as const, text }] : []), media.kind === "video"
    ? { type: "video_url", video_url: { url: media.dataUrl } }
    : { type: "image_url", image_url: { url: media.dataUrl, detail: "auto" } }];
}
