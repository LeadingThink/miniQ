// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { BrowserCapabilities, DaemonEvent } from "../types";
import { EMPTY_BROWSER_TABS, openBrowserTab, type BrowserTabsState } from "../browserTabs";
import { registerEmbeddedBrowser } from "../embeddedBrowserDriver";
import { useBrowserDriverEvents } from "./useBrowserDriverEvents";

afterEach(cleanup);
vi.mock("../browserWorkbench", () => ({ browserCapabilities: async () => capabilities }));

const capabilities: BrowserCapabilities = {
  navigationControl: true, domSnapshot: true, screenshot: true, tabs: false,
  pointerInput: true, keyboardInput: true, selectInput: true,
};

it("does not execute a remote host's browser requests in this computer's webview", () => {
  const onEvent = vi.fn();
  const client = { mode: "remote", sshHost: "devbox", onEvent } as unknown as RpcClient;
  renderHook(() => useBrowserDriverEvents(client, {}, vi.fn()));
  expect(onEvent).not.toHaveBeenCalled();
});

function fixture(initial: Record<string, BrowserTabsState> = {}) {
  let listener: (event: DaemonEvent) => void = () => {};
  const unsubscribe = vi.fn();
  const call = vi.fn(async () => ({ resolved: true }));
  const execute = vi.fn(async (_operation: string) => ({ url: "https://example.test/after-redirect" }));
  const executedPages: Array<{ viewId: string; operation: string; args: Record<string, unknown> }> = [];
  const client = {
    call,
    onEvent: (next: typeof listener) => { listener = next; return unsubscribe; },
  } as unknown as RpcClient;
  const view = renderHook(() => {
    const [sessions, setSessions] = useState<Record<string, BrowserTabsState>>(initial);
    useBrowserDriverEvents(client, sessions, setSessions);
    useEffect(() => {
      const unregister = Object.values(sessions).flatMap((state) => state.tabs.map((tab) =>
        registerEmbeddedBrowser(tab.viewId, { execute: async (operation, args) => {
          executedPages.push({ viewId: tab.viewId, operation, args });
          return execute(operation);
        }, capabilities: async () => capabilities }),
      ));
      return () => unregister.forEach((dispose) => dispose());
    }, [sessions]);
    return sessions;
  });
  let sequence = 0;
  const dispatch = async (sessionId: string, operation: string, args: Record<string, unknown> = {}, browserSessionId = sessionId) => {
    const id = `request-${++sequence}`;
    await act(async () => listener({
      type: "browser_driver_requested",
      request: { id, sessionId, browserSessionId, operation, arguments: args },
    }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("browser.resolve", expect.objectContaining({ requestId: id })));
  };
  return { ...view, dispatch, execute, executedPages, call, unsubscribe };
}

it("keeps one real task page across redirects, hiding, observation and redisplay", async () => {
  const view = fixture();
  await view.dispatch("first", "open", { url: "https://example.test/" });
  const tab = view.result.current.first.tabs[0];
  expect(tab.url).toBe("https://example.test/after-redirect");
  expect(view.result.current.first.tabs).toHaveLength(1);

  await view.dispatch("first", "setVisible", { visible: false });
  expect(view.result.current.first.open).toBe(false);
  await view.dispatch("first", "snapshot");
  expect(view.result.current.first.open).toBe(false);
  expect(view.result.current.first.tabs[0].viewId).toBe(tab.viewId);
  await view.dispatch("first", "setVisible", { visible: true });
  expect(view.result.current.first.open).toBe(true);
  expect(view.result.current.first.activeId).toBe(tab.id);
  expect(view.result.current.first.tabs).toHaveLength(1);

  view.unmount();
  expect(view.unsubscribe).toHaveBeenCalledOnce();
});

it("isolates another session and preserves its page until close actually succeeds", async () => {
  const view = fixture();
  await view.dispatch("first", "open", { url: "https://example.test/" });
  const first = view.result.current.first;
  await view.dispatch("second", "open", { url: "https://second.test/" });
  expect(view.result.current.first).toBe(first);
  expect(view.result.current.second.tabs[0].viewId).not.toBe(first.tabs[0].viewId);
  view.execute.mockRejectedValueOnce(new Error("native close failed"));
  await view.dispatch("second", "close");
  expect(view.result.current.second.tabs).toHaveLength(1);
  await view.dispatch("second", "close");
  expect(view.result.current.second.tabs).toHaveLength(0);
  expect(view.result.current.first).toBe(first);
});

it("discovers and observes the user's existing page without opening or reloading it", async () => {
  const state = openBrowserTab(EMPTY_BROWSER_TABS, "https://example.test/logged-in-form");
  const view = fixture({ first: state });
  const tab = state.tabs[0];
  await view.dispatch("first", "tabs");
  expect(view.call).toHaveBeenLastCalledWith("browser.resolve", expect.objectContaining({ result: {
    capabilities: { ...capabilities, tabs: true },
    result: { tabs: [{ tabId: tab.viewId, url: tab.url, active: true }], activeTabId: tab.viewId },
  } }));
  expect(view.execute).not.toHaveBeenCalled();
  await view.dispatch("first", "snapshot", { tabId: tab.viewId });
  await view.dispatch("first", "status");
  expect(view.executedPages.map((entry) => [entry.viewId, entry.operation])).toEqual([
    [tab.viewId, "snapshot"], [tab.viewId, "status"],
  ]);
  expect(view.result.current.first.tabs).toHaveLength(1);
});

it("lists, creates, switches and closes actual pages in one conversation", async () => {
  const state = openBrowserTab(EMPTY_BROWSER_TABS, "https://existing.test/");
  const view = fixture({ first: state });
  const first = state.tabs[0];
  await view.dispatch("first", "newTab", { url: "https://new.test/" });
  const second = view.result.current.first.tabs[1];
  expect(second.viewId).not.toBe(first.viewId);
  expect(view.executedPages.at(-1)?.operation).toBe("open");
  await view.dispatch("first", "switchTab", { tabId: first.viewId });
  expect(view.result.current.first.activeId).toBe(first.id);
  expect(view.executedPages.at(-1)).toMatchObject({ viewId: first.viewId, operation: "snapshot" });
  await view.dispatch("first", "closeTab", { tabId: second.viewId });
  expect(view.result.current.first.tabs.map((tab) => tab.id)).toEqual([first.id]);
  expect(view.executedPages.at(-1)).toMatchObject({ viewId: second.viewId, operation: "close" });
});

it("rejects pages from other conversations and keeps child pages isolated", async () => {
  const manual = openBrowserTab(EMPTY_BROWSER_TABS, "https://manual.test/");
  const other = openBrowserTab(EMPTY_BROWSER_TABS, "https://other.test/");
  const view = fixture({ first: manual, second: other });
  await view.dispatch("first", "snapshot", { tabId: other.tabs[0].viewId });
  expect(view.call).toHaveBeenLastCalledWith("browser.resolve", expect.objectContaining({ error: expect.stringContaining("不属于当前任务") }));
  await view.dispatch("first", "snapshot", { tabId: manual.tabs[0].viewId }, "first:child");
  expect(view.execute).not.toHaveBeenCalled();
  await view.dispatch("first", "open", { url: "https://child.test/" }, "first:child");
  const child = view.result.current.first.tabs[1];
  await view.dispatch("first", "tabs");
  const last = view.call.mock.calls.at(-1) as unknown as [string, { result: { result: { tabs: unknown[] } } }];
  expect(last[1].result.result.tabs).toEqual([{ tabId: manual.tabs[0].viewId, url: manual.tabs[0].url, active: true }]);
  await view.dispatch("first", "status", {}, "first:child");
  expect(view.executedPages.at(-1)?.viewId).toBe(child.viewId);
  expect(view.result.current.second).toBe(other);
});

it("routes a mutation to its observed page after the user selected another page", async () => {
  const first = openBrowserTab(EMPTY_BROWSER_TABS, "https://first.test/");
  const state = openBrowserTab(first, "https://second.test/");
  const view = fixture({ first: state });
  const expectedObservation = { tabId: first.tabs[0].viewId, observationId: "observed-first" };
  await view.dispatch("first", "click", { expectedObservation, target: "rpa-observed-first-0" });
  expect(view.executedPages.at(-1)).toMatchObject({ viewId: first.tabs[0].viewId, operation: "click", args: { expectedObservation } });
  expect(view.result.current.first.activeId).toBe(state.activeId);
});

it.each(["click", "back", "forward", "reload"])("rejects %s on a different explicitly selected page than the observation", async (operation) => {
  const first = openBrowserTab(EMPTY_BROWSER_TABS, "https://first.test/");
  const state = openBrowserTab(first, "https://second.test/");
  const view = fixture({ first: state });
  await view.dispatch("first", operation, {
    tabId: state.tabs[1].viewId,
    expectedObservation: { tabId: first.tabs[0].viewId, observationId: "observed-first" },
  });
  expect(view.call).toHaveBeenLastCalledWith("browser.resolve", expect.objectContaining({ error: expect.stringContaining("与当前页面观察不一致") }));
  expect(view.execute).not.toHaveBeenCalled();
  expect(view.result.current.first).toBe(state);
});

it("reports a missing page immediately without waiting for an unrelated browser host", async () => {
  const view = fixture();
  await view.dispatch("first", "snapshot");
  expect(view.call).toHaveBeenLastCalledWith("browser.resolve", expect.objectContaining({ error: expect.stringContaining("当前任务没有打开") }));
  expect(view.execute).not.toHaveBeenCalled();
});
