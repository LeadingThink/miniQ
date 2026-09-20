import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { flushSync } from "react-dom";
import type { RpcClient } from "../rpc";
import type { BrowserDriverRequest } from "../types";
import { executeEmbeddedBrowserRequest } from "../embeddedBrowserDriver";
import { browserCapabilities } from "../browserWorkbench";
import {
  closeBrowserTab, EMPTY_BROWSER_TABS, openBrowserTab, resolveTaskBrowserTab,
  selectTaskBrowserTab, taskBrowserTabs, updateBrowserTab,
  type BrowserTab, type BrowserTabsState,
} from "../browserTabs";

type BrowserSessions = Record<string, BrowserTabsState>;
type UpdateSession = (change: (state: BrowserTabsState) => BrowserTabsState) => void;

function requestedTabId(request: BrowserDriverRequest): string | undefined {
  const expected = request.arguments.expectedObservation;
  const observedTabId = expected && typeof expected === "object" && "tabId" in expected && typeof expected.tabId === "string"
    ? expected.tabId : undefined;
  const explicit = request.arguments.tabId;
  if (explicit !== undefined && explicit !== null) {
    if (typeof explicit !== "string" || !explicit) throw new Error("tabId 必须是 tabs 返回的标签页标识");
    if (observedTabId && explicit !== observedTabId) throw new Error("tabId 与当前页面观察不一致；请先切换标签并重新获取 snapshot");
    return explicit;
  }
  return observedTabId;
}

function preparePage(request: BrowserDriverRequest, state: BrowserTabsState, update: UpdateSession): BrowserTab {
  const { sessionId, browserSessionId, operation } = request;
  let tab = resolveTaskBrowserTab(state, sessionId, browserSessionId, requestedTabId(request));
  if (["open", "navigate", "newTab"].includes(operation)) {
    const url = request.arguments.url;
    if (typeof url !== "string") throw new Error("浏览器导航缺少 URL");
    if (!tab || operation === "newTab") {
      const opened = openBrowserTab(state, url, browserSessionId);
      tab = opened.tabs.find((candidate) => candidate.id === opened.activeId)!;
      update(() => selectTaskBrowserTab(opened, browserSessionId, tab!, true));
    } else {
      const selected = tab;
      update((current) => selectTaskBrowserTab(current, browserSessionId, selected, true));
    }
  }
  if (!tab) throw new Error("当前任务没有打开的内置浏览器页面；请先打开网页，或使用 open/newTab");
  const selected = tab;
  if (operation === "setVisible") {
    const visible = request.arguments.visible;
    if (typeof visible !== "boolean") throw new Error("setVisible 缺少 visible 参数");
    update((current) => visible
      ? selectTaskBrowserTab(current, browserSessionId, selected, true)
      : current.activeId === selected.id ? { ...current, open: false } : current);
  } else {
    update((current) => selectTaskBrowserTab(current, browserSessionId, selected, operation === "switchTab"));
  }
  return selected;
}

async function dispatchBrowserRequest(
  client: RpcClient, request: BrowserDriverRequest,
  getState: () => BrowserTabsState, update: UpdateSession,
) {
  try {
    if (request.operation === "tabs") {
      const state = getState();
      const selected = resolveTaskBrowserTab(state, request.sessionId, request.browserSessionId);
      const capabilities = await browserCapabilities();
      await client.call("browser.resolve", { requestId: request.id, result: {
        capabilities: { ...capabilities, tabs: capabilities.domSnapshot },
        result: { tabs: taskBrowserTabs(state, request.sessionId, request.browserSessionId)
          .map((tab) => ({ tabId: tab.viewId, url: tab.url, active: tab.id === selected?.id })),
          activeTabId: selected?.viewId ?? null },
      } });
      return;
    }
    const tab = preparePage(request, getState(), update);
    const operation = request.operation === "newTab" ? "open"
      : request.operation === "switchTab" ? "snapshot"
      : request.operation === "closeTab" ? "close" : request.operation;
    const response = await executeEmbeddedBrowserRequest(tab.viewId, operation, request.arguments);
    update((state) => {
      if (operation === "close") return closeBrowserTab(state, tab.id);
      return typeof response.result.url === "string" ? updateBrowserTab(state, tab.id, response.result.url) : state;
    });
    await client.call("browser.resolve", { requestId: request.id, result: {
      ...response, capabilities: { ...response.capabilities, tabs: response.capabilities.domSnapshot },
    } });
  } catch (cause) {
    await client.call("browser.resolve", {
      requestId: request.id, error: cause instanceof Error ? cause.message : String(cause),
    }).catch(() => {});
  }
}

export function useBrowserDriverEvents(
  client: RpcClient, sessions: BrowserSessions,
  setSessions: Dispatch<SetStateAction<BrowserSessions>>,
) {
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  useEffect(() => {
    if (client.mode === "remote") return;
    const queues = new Map<string, Promise<void>>();
    return client.onEvent((event) => {
      if (event.type !== "browser_driver_requested") return;
      const { request } = event;
      const key = `${request.sessionId}\0${request.browserSessionId}`;
      const getState = () => sessionsRef.current[request.sessionId] ?? EMPTY_BROWSER_TABS;
      const update: UpdateSession = (change) => flushSync(() => setSessions((current) => {
        const next = { ...current, [request.sessionId]: change(current[request.sessionId] ?? EMPTY_BROWSER_TABS) };
        sessionsRef.current = next;
        return next;
      }));
      // Preserve request order inside a task without serializing other tasks.
      const pending = (queues.get(key) ?? Promise.resolve())
        .then(() => dispatchBrowserRequest(client, request, getState, update));
      queues.set(key, pending);
      void pending.finally(() => { if (queues.get(key) === pending) queues.delete(key); });
    });
  }, [client, setSessions]);
}
