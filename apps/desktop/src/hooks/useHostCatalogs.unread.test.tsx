// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useHostCatalogs } from "./useHostCatalogs";
import { hostKey } from "../hostWorkspace";
import type { RpcClient } from "../rpc";
import type { DaemonEvent, SessionStatus } from "../types";

vi.mock("./useDaemonConnection", () => ({ useDaemonConnection: () => ({ connected: true }) }));
const runtime = vi.hoisted(() => ({ mobile: true }));
vi.mock("../mobileRuntime", () => ({ isNativeMobileApp: () => runtime.mobile }));
let visibility = "visible";
beforeEach(() => {
  localStorage.clear();
  visibility = "visible";
  runtime.mobile = true;
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility as DocumentVisibilityState);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function setup(initial: SessionStatus = "running", selected = true) {
  let status = initial;
  let selectedSessionId = selected ? "s1" : null;
  let releaseSessionList: (() => void) | null = null;
  const listeners = new Set<(event: DaemonEvent) => void>();
  const root = {
    connected: true,
    call: vi.fn(async (method: string) => {
      if (method === "workspace.list") return { workspaces: [] };
      if (releaseSessionList) await new Promise<void>((resolve) => { releaseSessionList = resolve; });
      return { sessions: [{ id: "s1", status }] };
    }),
    onEvent: (fn: (event: DaemonEvent) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
    onHostEvent: () => () => undefined,
  } as unknown as RpcClient;
  const hook = renderHook(() => useHostCatalogs(root, () => root, () => ({ host: null, navigation: { workspaceId: null, sessionId: selectedSessionId } })));
  await act(async () => hook.result.current.refreshCatalog(null));
  return { ...hook,
    unread: () => hook.result.current.catalogs[hostKey(null)].unreadSessionIds.has("s1"),
    refresh: async (next: SessionStatus) => { status = next; await act(async () => hook.result.current.refreshCatalog(null)); },
    delayNextSessionList: () => { releaseSessionList = () => {}; },
    releaseDelayedSessionList: async () => {
      const release = releaseSessionList;
      releaseSessionList = null;
      release?.();
      await act(async () => {});
    },
    select: (sessionId: string | null) => {
      selectedSessionId = sessionId;
      hook.rerender();
    },
    emit: async (next: SessionStatus, terminalEvent = false) => {
      status = next;
      await act(async () => listeners.forEach((fn) => fn(terminalEvent ? { type: "turn_completed", sessionId: "s1" } : { type: "session_status_changed", sessionId: "s1", status: next })));
    },
  };
}

it.each([false, true])("marks a selected background conversation unread (turn event=%s)", async (terminalEvent) => {
  const hook = await setup();
  visibility = "hidden";
  await hook.emit("idle", terminalEvent);
  await waitFor(() => expect(hook.unread()).toBe(true));
  expect(JSON.parse(localStorage.getItem("miniq.unread.v1:null")!)).toEqual(["s1"]);
  act(() => hook.result.current.markSeen(null, "s1"));
  expect(hook.unread()).toBe(true);
});
it("does not mark the selected foreground conversation unread", async () => {
  const hook = await setup();
  await hook.emit("idle");
  expect(hook.unread()).toBe(false);
});
it("does not reclassify a foreground terminal transition when turn_completed arrives after navigation", async () => {
  const hook = await setup();
  await hook.emit("idle");
  expect(hook.unread()).toBe(false);
  act(() => hook.select(null));
  await hook.emit("idle", true);
  expect(hook.unread()).toBe(false);
});
it.each([false, true])("keeps a foreground completion read when its delayed refresh lands after switching conversations (mobile=%s)", async (mobile) => {
  runtime.mobile = mobile;
  const hook = await setup();
  hook.delayNextSessionList();
  await hook.emit("idle", true);
  expect(hook.unread()).toBe(false);
  act(() => hook.select(null));
  await hook.releaseDelayedSessionList();
  await waitFor(() => expect(hook.unread()).toBe(false));
});
it("marks the selected conversation unread when a desktop window loses focus", async () => {
  runtime.mobile = false;
  const hook = await setup();
  vi.mocked(document.hasFocus).mockReturnValue(false);
  await hook.emit("failed");
  expect(hook.unread()).toBe(true);
});
it.each(["idle", "failed"] as const)("recovers missed %s after a reconnect catalog refresh", async (status) => {
  const hook = await setup("running", false);
  await hook.refresh(status);
  expect(hook.unread()).toBe(true);
  act(() => hook.result.current.markSeen(null, "s1"));
  await hook.refresh(status);
  expect(hook.unread()).toBe(false);
});
it("does not invent completions from an initial terminal snapshot", async () => {
  const hook = await setup("idle", false);
  expect(hook.unread()).toBe(false);
});

it("recovers the selected session while backgrounded and preserves the marker on foreground refresh", async () => {
  const hook = await setup();
  visibility = "hidden";
  await hook.refresh("idle");
  expect(hook.unread()).toBe(true);
  visibility = "visible";
  await hook.refresh("idle");
  expect(hook.unread()).toBe(true);
  act(() => hook.result.current.markSeen(null, "s1"));
  expect(hook.unread()).toBe(false);
});
it("does not depend on WebView focus for a visible native mobile conversation", async () => {
  const hook = await setup();
  vi.mocked(document.hasFocus).mockReturnValue(false);
  await hook.emit("idle");
  expect(hook.unread()).toBe(false);
});
