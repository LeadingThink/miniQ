// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ATTENTION_INBOX_STORAGE_KEY, getAttentionItems, recordAttentionItem, type AttentionItem } from "./companionInbox";
import { getLocalAttentionItems, localCompanionNotices } from "./companionInboxAdapter";
import { useCompanionInbox } from "./hooks/useCompanionInbox";
import type { Session, Workspace } from "./types";
const workspaces = [{ id: "w" }] as Workspace[];
const sessions = [{ id: "s", workspaceId: "w" }] as Session[];
beforeEach(() => localStorage.clear());
afterEach(cleanup);
const item = (overrides: Partial<AttentionItem> = {}): AttentionItem => ({
  id: "n", host: null, workspaceId: "w", sessionId: "s", kind: "completed", eventKey: "completed", title: "任务", detail: "完成", state: "unread", createdAt: 1, ...overrides,
});
it("filters wrong hosts, device targets and workspace/session pairings", () => {
  const items = [item(), item({ host: "ssh" }), item({ targetDeviceId: "relay" }), item({ workspaceId: "wrong" }), item({ state: "read" }), item({ state: "snoozed" }), item({ sessionId: "missing" })];
  expect(localCompanionNotices(items, workspaces, sessions)).toEqual([{ id: "n", sessionId: "s", workspaceId: "w", state: "ready", text: "完成" }]);
  expect(localCompanionNotices([item()], workspaces, [{ ...sessions[0], external: { provider: "codex", externalId: "ext", sourcePath: "/external", continuationMode: "read_only", importedAt: "2026-01-01", lastSyncedAt: "2026-01-01" } }])).toEqual([]);
});
it("pages all local notices instead of losing entries after the first inbox page", () => {
  const items = Array.from({ length: 205 }, (_, index) => item({ id: `n${index}`, createdAt: index }));
  localStorage.setItem(ATTENTION_INBOX_STORAGE_KEY, JSON.stringify({ items }));
  expect(getLocalAttentionItems()).toHaveLength(205);
  expect(getLocalAttentionItems()[0].id).toBe("n204");
});
it("loads before mount, follows cross-window storage events and marks only local entries read", () => {
  recordAttentionItem(item());
  const hook = renderHook(() => useCompanionInbox(workspaces, sessions));
  expect(hook.result.current.notices).toHaveLength(1);
  act(() => {
    localStorage.setItem(ATTENTION_INBOX_STORAGE_KEY, JSON.stringify({ items: [item(), item({ id: "new", kind: "question", createdAt: 2 })] }));
    window.dispatchEvent(new StorageEvent("storage", { key: ATTENTION_INBOX_STORAGE_KEY }));
  });
  expect(hook.result.current.notices.map((notice) => notice.id)).toEqual(["new", "n"]);
  expect(hook.result.current.notices[0].state).toBe("needs_input");
  act(() => hook.result.current.onNoticeOpened("new"));
  expect(hook.result.current.notices.map((notice) => notice.id)).toEqual(["n"]);
  expect(getAttentionItems().items[0].state).toBe("read");
});
