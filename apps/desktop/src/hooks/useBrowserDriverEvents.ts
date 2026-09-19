import { useEffect, type Dispatch, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import type { RpcClient } from "../rpc";
import { resolveBrowserDriverRequest } from "../embeddedBrowserDriver";
import {
  closeBrowserTab,
  EMPTY_BROWSER_TABS,
  openTaskBrowserTab,
  setTaskBrowserVisible,
  updateBrowserTab,
  type BrowserTabsState,
} from "../browserTabs";

export function useBrowserDriverEvents(
  client: RpcClient,
  setSessions: Dispatch<SetStateAction<Record<string, BrowserTabsState>>>,
) {
  useEffect(() => client.onEvent((event) => {
    if (event.type !== "browser_driver_requested") return;
    const { request } = event;
    const requestedUrl = request.arguments.url;
    if (request.operation === "open" || request.operation === "navigate") {
      if (typeof requestedUrl !== "string") {
        void client.call("browser.resolve", {
          requestId: request.id,
          error: "浏览器导航缺少 URL",
        });
        return;
      }
      // Commit the real task host before the adapter executes. Tool history is
      // an audit trail, not a second source of pages or presentation state.
      flushSync(() => setSessions((current) => ({
        ...current,
        [request.sessionId]: openTaskBrowserTab(current[request.sessionId] ?? EMPTY_BROWSER_TABS, request.browserSessionId, requestedUrl),
      })));
    } else if (request.operation === "setVisible" && typeof request.arguments.visible === "boolean") {
      const visible = request.arguments.visible;
      flushSync(() => setSessions((current) => ({
        ...current,
        [request.sessionId]: setTaskBrowserVisible(current[request.sessionId] ?? EMPTY_BROWSER_TABS, request.browserSessionId, visible),
      })));
    }
    void resolveBrowserDriverRequest(client, request).then((result) => {
      if (!result) return;
      setSessions((current) => {
        const state = current[request.sessionId];
        const tab = state?.tabs.find((candidate) => candidate.browserSessionId === request.browserSessionId);
        if (!tab) return current;
        if (request.operation === "close") {
          return { ...current, [request.sessionId]: closeBrowserTab(state, tab.id) };
        }
        return typeof result.url === "string"
          ? { ...current, [request.sessionId]: updateBrowserTab(state, tab.id, result.url) }
          : current;
      });
    });
  }), [client, setSessions]);
}
