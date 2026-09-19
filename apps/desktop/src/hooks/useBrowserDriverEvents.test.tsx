// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { BrowserCapabilities, DaemonEvent } from "../types";
import { type BrowserTabsState } from "../browserTabs";
import { registerEmbeddedBrowser } from "../embeddedBrowserDriver";
import { useBrowserDriverEvents } from "./useBrowserDriverEvents";

afterEach(cleanup);

const capabilities: BrowserCapabilities = {
  navigationControl: true, domSnapshot: true, screenshot: true, tabs: false,
  pointerInput: true, keyboardInput: true, selectInput: true,
};

function fixture() {
  let listener: (event: DaemonEvent) => void = () => {};
  const unsubscribe = vi.fn();
  const call = vi.fn(async () => ({ resolved: true }));
  const execute = vi.fn(async (_operation: string) => ({ url: "https://example.test/after-redirect" }));
  const client = {
    call,
    onEvent: (next: typeof listener) => { listener = next; return unsubscribe; },
  } as unknown as RpcClient;
  const view = renderHook(() => {
    const [sessions, setSessions] = useState<Record<string, BrowserTabsState>>({});
    useBrowserDriverEvents(client, setSessions);
    useEffect(() => {
      const unregister = Object.values(sessions).flatMap((state) => state.tabs.map((tab) =>
        registerEmbeddedBrowser(tab.browserSessionId!, { execute, capabilities: async () => capabilities }),
      ));
      return () => unregister.forEach((dispose) => dispose());
    }, [sessions]);
    return sessions;
  });
  let sequence = 0;
  const dispatch = async (sessionId: string, operation: string, args: Record<string, unknown> = {}) => {
    const id = `request-${++sequence}`;
    await act(async () => listener({
      type: "browser_driver_requested",
      request: { id, sessionId, browserSessionId: `task-${sessionId}`, operation, arguments: args },
    }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("browser.resolve", expect.objectContaining({ requestId: id })));
  };
  return { ...view, dispatch, execute, unsubscribe };
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
