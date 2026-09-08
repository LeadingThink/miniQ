import type { RpcClient } from "./rpc";
import type { ToolCall } from "./types";

export interface ObservationImage { id: string; width: number; height: number; bytes: number }

export function observationPages(call: ToolCall): number[] {
  if (call.toolName !== "view_pdf") return [];
  const pages = (call.output as { pages?: Array<{ page?: number }> } | null)?.pages;
  return Array.isArray(pages) ? pages.map(page => page.page).filter((page): page is number => Number.isSafeInteger(page) && page! > 0) : [];
}

export function observationImage(call: ToolCall, imageIndex = 0): ObservationImage | null {
  if (!["computer_use", "browser_automation", "view_image", "view_pdf"].includes(call.toolName)) return null;
  const output = call.output as { screenshot?: Partial<ObservationImage>; pages?: Array<{ screenshot?: Partial<ObservationImage> }> } | null;
  const value = call.toolName === "view_pdf" ? output?.pages?.[imageIndex]?.screenshot : imageIndex === 0 ? output?.screenshot : null;
  if (!value || typeof value.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id)
    || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height)
    || !Number.isSafeInteger(value.bytes) || value.width! <= 0 || value.height! <= 0
    || value.bytes! <= 0 || value.bytes! > 20 * 1024 * 1024) return null;
  return value as ObservationImage;
}

interface Chunk { offset: number; nextOffset: number; totalBytes: number; done: boolean; mimeType: string; base64: string }

export async function loadObservation(client: RpcClient, call: ToolCall, signal: AbortSignal, imageIndex = 0): Promise<Blob> {
  const image = observationImage(call, imageIndex);
  if (!image) throw new Error("无效的截图记录");
  const chunks: ArrayBuffer[] = [];
  let offset = 0;
  while (offset < image.bytes) {
    signal.throwIfAborted();
    const chunk = await client.call<Chunk>("observation.read", { sessionId: call.sessionId, toolCallId: call.id, offset,
      ...(call.toolName === "view_pdf" ? { imageIndex } : {}) });
    signal.throwIfAborted();
    if (typeof chunk.base64 !== "string" || chunk.base64.length > 349_528) throw new Error("截图分块大小无效");
    const bytes = Uint8Array.from(atob(chunk.base64), character => character.charCodeAt(0));
    if (chunk.offset !== offset || chunk.totalBytes !== image.bytes || chunk.mimeType !== "image/png"
      || bytes.length === 0 || bytes.length > 256 * 1024 || chunk.nextOffset !== offset + bytes.length
      || chunk.nextOffset > image.bytes || chunk.done !== (chunk.nextOffset === image.bytes)) {
      throw new Error("截图数据不完整，请重新加载");
    }
    chunks.push(bytes.buffer);
    offset = chunk.nextOffset;
  }
  return new Blob(chunks, { type: "image/png" });
}
