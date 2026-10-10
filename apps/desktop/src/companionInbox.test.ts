// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ATTENTION_INBOX_STORAGE_KEY,
  getAttentionItems,
  getSummary,
  markRead,
  recordAttentionItem,
  snooze,
} from "./companionInbox";

const input = (eventKey: string, overrides: Record<string, unknown> = {}) => ({
  host: null,
  sessionId: "session-1",
  kind: "completed" as const,
  eventKey,
  title: "整理周报",
  detail: "任务已完成",
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("companion inbox", () => {
  it("persists valid items and dedupes by scoped event key, not title", () => {
    expect(recordAttentionItem(input("cursor:1"))).toMatchObject({ ok: true, duplicate: undefined });
    expect(recordAttentionItem(input("cursor:1"))).toMatchObject({ ok: true, duplicate: true });
    expect(recordAttentionItem(input("cursor:2"))).toMatchObject({ ok: true });
    expect(recordAttentionItem(input("cursor:1", { host: "remote" }))).toMatchObject({ ok: true });
    expect(getAttentionItems().total).toBe(3);
    expect(JSON.parse(localStorage.getItem(ATTENTION_INBOX_STORAGE_KEY)!).items).toHaveLength(3);
  });

  it("keeps tombstones when read and snoozed", () => {
    const created = recordAttentionItem(input("e1"));
    const id = created.item!.id;
    expect(markRead(id).ok).toBe(true);
    expect(getSummary()).toMatchObject({ total: 1, unread: 0, read: 1 });
    expect(snooze(id, Date.now() + 60_000).ok).toBe(true);
    expect(getSummary()).toMatchObject({ total: 1, unread: 0, read: 0, snoozed: 1 });
    expect(getAttentionItems().items[0].id).toBe(id);
  });

  it("reports malformed and unavailable storage clearly", () => {
    localStorage.setItem(ATTENTION_INBOX_STORAGE_KEY, "{broken");
    expect(getAttentionItems().error).toMatch(/无法解析/);
    localStorage.clear();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(recordAttentionItem(input("e2"))).toMatchObject({ ok: false, error: expect.stringContaining("无法保存") });
  });

  it("supports pagination without dropping older records", () => {
    recordAttentionItem(input("old", { createdAt: 1 }));
    recordAttentionItem(input("new", { createdAt: 2 }));
    expect(getAttentionItems({ offset: 0, limit: 1 })).toMatchObject({ total: 2, hasMore: true, items: [{ eventKey: "new" }] });
    expect(getAttentionItems({ offset: 1, limit: 1 }).items[0].eventKey).toBe("old");
  });
});
