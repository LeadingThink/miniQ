export type AttentionKind = "completed" | "failed" | "approval" | "question" | "reminder";
export type AttentionState = "unread" | "read" | "snoozed";

export interface AttentionItem {
  id: string;
  host: string | null;
  targetDeviceId?: string;
  sessionId: string;
  workspaceId?: string;
  kind: AttentionKind;
  eventKey: string;
  title: string;
  detail: string;
  state: AttentionState;
  createdAt: number;
  readAt?: number;
  snoozeUntil?: number;
}

export interface AttentionInboxOptions {
  host?: string | null;
  sessionId?: string;
  state?: AttentionState;
  offset?: number;
  limit?: number;
}

export interface AttentionItemsResult {
  ok: boolean;
  items: AttentionItem[];
  total: number;
  hasMore: boolean;
  error?: string;
}

export interface AttentionSummary {
  ok: boolean;
  total: number;
  unread: number;
  read: number;
  snoozed: number;
  error?: string;
}

export interface RecordAttentionResult {
  ok: boolean;
  item?: AttentionItem;
  duplicate?: boolean;
  error?: string;
}

export const ATTENTION_INBOX_STORAGE_KEY = "miniq.attentionInbox.v1";
export const ATTENTION_INBOX_EVENT = "miniq:attention-inbox";
const MAX_PAGE_SIZE = 200;
let nextId = 0;

type StoredState = { items: AttentionItem[] };
type ChangeListener = (result: AttentionItemsResult) => void;

const listeners = new Set<ChangeListener>();
let externalListenersStarted = false;

function now(): number {
  return Date.now();
}

function makeId(): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${now()}-${++nextId}`;
  return `attention-${random}`;
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; } catch { return null; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAttentionItem(value: unknown): value is AttentionItem {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" &&
    (typeof value.host === "string" || value.host === null) &&
    typeof value.sessionId === "string" &&
    ["completed", "failed", "approval", "question", "reminder"].includes(String(value.kind)) &&
    typeof value.eventKey === "string" && typeof value.title === "string" &&
    typeof value.detail === "string" &&
    ["unread", "read", "snoozed"].includes(String(value.state)) &&
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt) &&
    (value.targetDeviceId === undefined || typeof value.targetDeviceId === "string") &&
    (value.workspaceId === undefined || typeof value.workspaceId === "string") &&
    (value.readAt === undefined || typeof value.readAt === "number") &&
    (value.snoozeUntil === undefined || typeof value.snoozeUntil === "number");
}

function readState(): { state: StoredState; error?: string } {
  const store = storage();
  if (!store) return { state: { items: [] }, error: "提醒收件箱存储不可用，当前不会持久化" };
  let raw: string | null;
  try { raw = store.getItem(ATTENTION_INBOX_STORAGE_KEY); } catch {
    return { state: { items: [] }, error: "提醒收件箱无法读取，当前不会持久化" };
  }
  if (!raw) return { state: { items: [] } };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.items) || !parsed.items.every(isAttentionItem)) {
      return { state: { items: [] }, error: "提醒收件箱数据格式损坏，未加载其中内容" };
    }
    return { state: { items: parsed.items }, };
  } catch {
    return { state: { items: [] }, error: "提醒收件箱数据无法解析，未加载其中内容" };
  }
}

function writeState(state: StoredState): string | undefined {
  const store = storage();
  if (!store) return "提醒收件箱存储不可用，提醒只保留在当前事件中";
  try {
    store.setItem(ATTENTION_INBOX_STORAGE_KEY, JSON.stringify(state));
    return undefined;
  } catch {
    return "提醒收件箱无法保存，提醒未确认已持久化";
  }
}

function dispatchChange(operation: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ATTENTION_INBOX_EVENT, { detail: { operation } }));
}

function notify(): void {
  const result = getAttentionItems();
  for (const listener of listeners) listener(result);
}

function ensureExternalListeners(): void {
  if (typeof window === "undefined" || externalListenersStarted) return;
  externalListenersStarted = true;
  window.addEventListener(ATTENTION_INBOX_EVENT, notify);
  window.addEventListener("storage", (event) => {
    if (event.key === ATTENTION_INBOX_STORAGE_KEY) notify();
  });
}

function filteredItems(options: AttentionInboxOptions = {}): { items: AttentionItem[]; error?: string } {
  const loaded = readState();
  let items = loaded.state.items;
  if (options.host !== undefined) items = items.filter((item) => item.host === options.host);
  if (options.sessionId !== undefined) items = items.filter((item) => item.sessionId === options.sessionId);
  if (options.state !== undefined) items = items.filter((item) => item.state === options.state);
  items = [...items].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  return { items, error: loaded.error };
}

export function getAttentionItems(options: AttentionInboxOptions = {}): AttentionItemsResult {
  ensureExternalListeners();
  const loaded = filteredItems(options);
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  const requested = options.limit === undefined ? MAX_PAGE_SIZE : Math.max(0, Math.floor(options.limit));
  const limit = Math.min(MAX_PAGE_SIZE, requested);
  return {
    ok: !loaded.error,
    items: loaded.items.slice(offset, offset + limit),
    total: loaded.items.length,
    hasMore: offset + limit < loaded.items.length,
    ...(loaded.error ? { error: loaded.error } : {}),
  };
}

export function getSummary(options: Omit<AttentionInboxOptions, "offset" | "limit" | "state"> = {}): AttentionSummary {
  ensureExternalListeners();
  const loaded = filteredItems(options);
  const summary = { total: loaded.items.length, unread: 0, read: 0, snoozed: 0 };
  for (const item of loaded.items) summary[item.state] += 1;
  return { ok: !loaded.error, ...summary, ...(loaded.error ? { error: loaded.error } : {}) };
}

export function recordAttentionItem(input: Omit<AttentionItem, "id" | "state" | "createdAt"> & Partial<Pick<AttentionItem, "id" | "state" | "createdAt">>): RecordAttentionResult {
  ensureExternalListeners();
  const loaded = readState();
  if (loaded.error) return { ok: false, error: loaded.error };
  const duplicate = loaded.state.items.find((item) => item.host === input.host && item.eventKey === input.eventKey);
  if (duplicate) return { ok: true, item: duplicate, duplicate: true };
  const item: AttentionItem = {
    ...input,
    id: input.id ?? makeId(),
    state: input.state ?? "unread",
    createdAt: input.createdAt ?? now(),
  };
  if (!isAttentionItem(item)) return { ok: false, error: "提醒收件箱拒绝了格式不完整的提醒" };
  const error = writeState({ items: [...loaded.state.items, item] });
  if (error) return { ok: false, error };
  dispatchChange("record");
  return { ok: true, item };
}

function updateItem(id: string, update: (item: AttentionItem) => AttentionItem): RecordAttentionResult {
  ensureExternalListeners();
  const loaded = readState();
  if (loaded.error) return { ok: false, error: loaded.error };
  const current = loaded.state.items.find((item) => item.id === id);
  if (!current) return { ok: false, error: "提醒不存在或已被外部更新" };
  const item = update(current);
  const items = loaded.state.items.map((entry) => entry.id === id ? item : entry);
  const error = writeState({ items });
  if (error) return { ok: false, error };
  dispatchChange("update");
  return { ok: true, item };
}

export function markRead(id: string): RecordAttentionResult {
  return updateItem(id, (item) => ({ ...item, state: "read", readAt: now(), snoozeUntil: undefined }));
}

export function snooze(id: string, snoozeUntil: number): RecordAttentionResult {
  if (!Number.isFinite(snoozeUntil) || snoozeUntil <= now()) return { ok: false, error: "提醒稍后时间无效" };
  return updateItem(id, (item) => ({ ...item, state: "snoozed", snoozeUntil }));
}

export function subscribe(listener: ChangeListener): () => void {
  ensureExternalListeners();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
