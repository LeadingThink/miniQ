import { requestZaiwen, type ZaiwenResponse } from "./zaiwenApi";
import type { ZaiwenSession } from "./zaiwenAuth";

export interface ZaiwenConversation {
  id: string;
  title: string;
  created: number | string;
  updated?: number | string;
  pinned?: boolean;
  type?: string;
}

export interface ZaiwenMessage extends Record<string, unknown> {
  id: string;
  role: string;
  content: string;
  created: number | string;
  model?: string;
  type?: string;
}

export interface ZaiwenPage<T> {
  items: T[];
  total: number;
  cursor: string | null;
}

export function zaiwenTimestamp(value: number | string): number {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  return Date.parse(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validDate(value: unknown): value is number | string {
  return (typeof value === "number" || typeof value === "string") && Number.isFinite(zaiwenTimestamp(value));
}

function conversation(value: unknown): value is ZaiwenConversation {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0
    && typeof value.title === "string" && validDate(value.created)
    && (value.updated === undefined || validDate(value.updated));
}

export function isZaiwenMessage(value: unknown): value is ZaiwenMessage {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0
    && typeof value.role === "string" && typeof value.content === "string" && validDate(value.created);
}

function page<T>(response: ZaiwenResponse<unknown>, check: (value: unknown) => value is T, cursor?: string | null): ZaiwenPage<T> {
  if (!Array.isArray(response.data) || !response.data.every(check)) throw new Error("在问聊天记录格式无效，请重试");
  // create_response omits total when it is zero; an empty history is valid.
  const total = response.total ?? (response.data.length === 0 ? 0 : undefined);
  if (!Number.isSafeInteger(total) || total! < 0
    || !(response.next_cursor === null || (typeof response.next_cursor === "string" && response.next_cursor.length > 0))
    || (cursor && response.next_cursor === cursor)) throw new Error("在问聊天记录分页信息无效，请刷新重试");
  return { items: response.data, total: total!, cursor: response.next_cursor };
}

export async function listZaiwenConversations(session: ZaiwenSession, cursor?: string | null, signal?: AbortSignal): Promise<ZaiwenPage<ZaiwenConversation>> {
  const query = new URLSearchParams({ limit: "30" });
  if (cursor) query.set("cursor", cursor);
  return page(await requestZaiwen(`ai/conversations?${query}`, { method: "GET", signal }, session.token), conversation, cursor);
}

export async function listZaiwenMessages(session: ZaiwenSession, conversationId: string, cursor?: string | null, signal?: AbortSignal): Promise<ZaiwenPage<ZaiwenMessage>> {
  const query = new URLSearchParams({ conversation_id: conversationId, limit: "50" });
  if (cursor) query.set("cursor", cursor);
  return page(await requestZaiwen(`ai/messages?${query}`, { method: "GET", signal }, session.token), isZaiwenMessage, cursor);
}

export function mergeZaiwenPage<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
  return [...new Map([...previous, ...incoming].map((item) => [item.id, item])).values()];
}
