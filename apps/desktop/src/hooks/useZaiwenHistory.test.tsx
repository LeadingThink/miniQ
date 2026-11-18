// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useZaiwenHistory } from "./useZaiwenHistory";
import { listZaiwenConversations, listZaiwenMessages, type ZaiwenPage, type ZaiwenMessage } from "../zaiwenHistory";
import { ZaiwenApiError } from "../zaiwenApi";

vi.mock("../zaiwenHistory", async (original) => ({
  ...await original<typeof import("../zaiwenHistory")>(),
  listZaiwenConversations: vi.fn(), listZaiwenMessages: vi.fn(),
}));
const owner = { token: "owner-token", user: { uid: "owner" } };
const conversation = { id: "cloud-1", title: "主站记录", created: 1_700_000_000 };
const message = (id: string, created: number, content = id): ZaiwenMessage => ({ id, created, content, role: "assistant" });
beforeEach(() => {
  vi.mocked(listZaiwenConversations).mockReset().mockResolvedValue({ items: [conversation], total: 1, cursor: null });
  vi.mocked(listZaiwenMessages).mockReset().mockResolvedValue({ items: [], total: 0, cursor: null });
});
afterEach(cleanup);

it("paginates conversations and merges edited records without duplicates", async () => {
  vi.mocked(listZaiwenConversations)
    .mockResolvedValueOnce({ items: [conversation], total: 2, cursor: "next" })
    .mockResolvedValueOnce({ items: [{ ...conversation, title: "更新后的标题" }, { ...conversation, id: "cloud-2" }], total: 2, cursor: null });
  const { result } = renderHook(() => useZaiwenHistory(owner, true));
  await waitFor(() => expect(result.current.conversations.cursor).toBe("next"));
  await act(() => result.current.conversations.loadMore());
  await waitFor(() => expect(result.current.conversations.items).toHaveLength(2));
  expect(result.current.conversations.items[0].title).toBe("更新后的标题");
  expect(listZaiwenConversations).toHaveBeenLastCalledWith(owner, "next", expect.any(AbortSignal));
});

it("loads older messages in chronological order and preserves refreshed message content", async () => {
  vi.mocked(listZaiwenMessages)
    .mockResolvedValueOnce({ items: [message("m2", 2), message("m3", 3)], total: 3, cursor: "older" })
    .mockResolvedValueOnce({ items: [message("m1", 1), message("m2", 2, "edited")], total: 3, cursor: null });
  const { result } = renderHook(() => useZaiwenHistory(owner, true));
  act(() => result.current.select(conversation));
  await waitFor(() => expect(result.current.messages.cursor).toBe("older"));
  await act(() => result.current.messages.loadMore());
  await waitFor(() => expect(result.current.messages.items.map((item) => item.content)).toEqual(["m1", "edited", "m3"]));
});

it("discards a late response after changing conversations", async () => {
  let finish!: (value: ZaiwenPage<ZaiwenMessage>) => void;
  vi.mocked(listZaiwenMessages).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce({ items: [message("new", 1)], total: 1, cursor: null });
  const { result } = renderHook(() => useZaiwenHistory(owner, true));
  act(() => result.current.select(conversation));
  await waitFor(() => expect(listZaiwenMessages).toHaveBeenCalledOnce());
  const oldSignal = vi.mocked(listZaiwenMessages).mock.calls[0][3]!;
  act(() => result.current.select({ ...conversation, id: "another" }));
  await waitFor(() => expect(result.current.messages.items[0]?.id).toBe("new"));
  await act(async () => finish({ items: [message("old", 1)], total: 1, cursor: null }));
  expect(oldSignal.aborted).toBe(true);
  expect(result.current.messages.items.map((item) => item.id)).toEqual(["new"]);
});

it("clears the previous account immediately and ignores its in-flight response", async () => {
  let finish!: (value: ZaiwenPage<typeof conversation>) => void;
  vi.mocked(listZaiwenConversations).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce({ items: [{ ...conversation, id: "second-owner" }], total: 1, cursor: null });
  const second = { token: "second-token", user: { uid: "second" } };
  const { result, rerender } = renderHook(({ session }) => useZaiwenHistory(session, true), { initialProps: { session: owner } });
  act(() => result.current.select(conversation));
  rerender({ session: second });
  expect(result.current.selected).toBeNull();
  expect(result.current.messages.items).toEqual([]);
  expect(result.current.conversations.items).toEqual([]);
  await waitFor(() => expect(result.current.conversations.items[0]?.id).toBe("second-owner"));
  await act(async () => finish({ items: [conversation], total: 1, cursor: null }));
  expect(result.current.conversations.items[0].id).toBe("second-owner");
});

it("refreshes when reentering the cloud platform and on window focus", async () => {
  const { result, rerender } = renderHook(({ active }) => useZaiwenHistory(owner, active), { initialProps: { active: true } });
  await waitFor(() => expect(result.current.conversations.items).toHaveLength(1));
  rerender({ active: false });
  act(() => window.dispatchEvent(new Event("focus")));
  expect(listZaiwenConversations).toHaveBeenCalledOnce();
  rerender({ active: true });
  await waitFor(() => expect(listZaiwenConversations).toHaveBeenCalledTimes(2));
  act(() => window.dispatchEvent(new Event("focus")));
  await waitFor(() => expect(listZaiwenConversations).toHaveBeenCalledTimes(3));
});

it("keeps loaded records on network errors, supports retry and clears them on expired login", async () => {
  const { result } = renderHook(() => useZaiwenHistory(owner, true));
  await waitFor(() => expect(result.current.conversations.items).toHaveLength(1));
  vi.mocked(listZaiwenConversations).mockRejectedValueOnce(new Error("offline"));
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.conversations.error).toBe("offline"));
  expect(result.current.conversations.items).toHaveLength(1);
  vi.mocked(listZaiwenConversations).mockRejectedValueOnce(new ZaiwenApiError("expired", 401));
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.requiresLogin).toBe(true));
  expect(result.current.conversations.items).toEqual([]);
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.requiresLogin).toBe(false));
  expect(result.current.conversations.items).toHaveLength(1);
});

it("never requests history while signed out", () => {
  const { result } = renderHook(() => useZaiwenHistory(null, true));
  act(() => { result.current.refresh(); result.current.conversations.loadMore(); });
  expect(listZaiwenConversations).not.toHaveBeenCalled();
  expect(listZaiwenMessages).not.toHaveBeenCalled();
});

it("only requests history in the cloud platform and cancels messages when leaving it", async () => {
  let finish!: (page: ZaiwenPage<ZaiwenMessage>) => void;
  vi.mocked(listZaiwenMessages).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValueOnce({ items: [message("fresh", 2)], total: 1, cursor: null });
  const { result, rerender } = renderHook(({ active }) => useZaiwenHistory(owner, active), { initialProps: { active: false } });
  expect(listZaiwenConversations).not.toHaveBeenCalled();
  rerender({ active: true });
  act(() => result.current.select(conversation));
  await waitFor(() => expect(listZaiwenMessages).toHaveBeenCalledOnce());
  const pending = vi.mocked(listZaiwenMessages).mock.calls[0][3]!;
  rerender({ active: false });
  expect(pending.aborted).toBe(true);
  await act(async () => finish({ items: [message("stale", 1)], total: 1, cursor: null }));
  expect(result.current.messages.items).toEqual([]);
  rerender({ active: true });
  await waitFor(() => expect(result.current.messages.items[0]?.id).toBe("fresh"));
});

it("updates the selected title after refreshing the cloud conversation list", async () => {
  const { result } = renderHook(() => useZaiwenHistory(owner, true));
  await waitFor(() => expect(result.current.conversations.items).toHaveLength(1));
  act(() => result.current.select(conversation));
  vi.mocked(listZaiwenConversations).mockResolvedValueOnce({ items: [{ ...conversation, title: "主站新标题" }], total: 1, cursor: null });
  act(() => result.current.refresh());
  await waitFor(() => expect(result.current.selected?.title).toBe("主站新标题"));
});

it("returns pagination failures to the shared timeline while retaining loaded records", async () => {
  vi.mocked(listZaiwenMessages).mockResolvedValueOnce({ items: [message("recent", 2)], total: 2, cursor: "older" })
    .mockRejectedValueOnce(new Error("offline"));
  const { result } = renderHook(() => useZaiwenHistory(owner, true));
  act(() => result.current.select(conversation));
  await waitFor(() => expect(result.current.messages.cursor).toBe("older"));
  await act(async () => {
    expect(await result.current.messages.loadMore()).toEqual({ error: expect.objectContaining({ message: "offline" }) });
  });
  expect(result.current.messages.items.map((item) => item.id)).toEqual(["recent"]);
  expect(result.current.messages.cursor).toBe("older");
});
