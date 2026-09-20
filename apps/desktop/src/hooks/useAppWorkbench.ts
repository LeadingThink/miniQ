import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import type { MiniqAppController } from "./useMiniqApp";
import { useBrowserDriverEvents } from "./useBrowserDriverEvents";
import { openExternalUrl } from "../externalLinks";
import type { LocalFileTarget } from "../localFiles";
import {
  adoptDraftBrowserTabs,
  BROWSER_DRAFT_CREATED_EVENT,
  browserDraftScope,
  closeBrowserTab,
  EMPTY_BROWSER_TABS,
  openBrowserTab,
  updateBrowserTab,
  type BrowserDraftCreatedDetail,
  type BrowserTabsState,
} from "../browserTabs";

export type WorkbenchView = "overview" | "files" | "browser" | "review";

/** One controller for panel navigation; browser instances retain their stable IDs. */
export function useAppWorkbench(app: MiniqAppController) {
  const scope =
    app.catalog.currentSessionId ??
    browserDraftScope(app.catalog.selectedWorkspace?.id);
  const [browserSessions, setBrowserSessions] = useState<
    Record<string, BrowserTabsState>
  >({});
  const [remoteBrowserSession, setRemoteBrowserSession] = useState<
    string | null
  >(null);
  const [sections, setSections] = useState<
    Record<string, WorkbenchView | null>
  >({});
  const browserState = browserSessions[scope] ?? EMPTY_BROWSER_TABS;
  const activeBrowserTab =
    browserState.tabs.find((tab) => tab.id === browserState.activeId) ?? null;
  const browserUrl = browserState.open ? (activeBrowserTab?.url ?? null) : null;
  const remoteBrowserOpen =
    app.client.mode === "remote" &&
    remoteBrowserSession !== null &&
    remoteBrowserSession === app.catalog.currentSessionId;
  const active: WorkbenchView | null =
    browserUrl || remoteBrowserOpen
      ? "browser"
      : app.preview.state.open
        ? "files"
        : app.review.open
          ? "review"
          : (sections[scope] ?? null);
  const setSection = (value: WorkbenchView | null) =>
    setSections((current) => ({ ...current, [scope]: value }));
  const hideBrowser = () => {
    setRemoteBrowserSession(null);
    setBrowserSessions((current) => ({
      ...current,
      [scope]: { ...(current[scope] ?? EMPTY_BROWSER_TABS), open: false },
    }));
  };
  const close = () => {
    hideBrowser();
    app.preview.close();
    app.review.setOpen(false);
    setSection(null);
  };
  const newBrowserTab = (url = "https://www.bing.com/") => {
    app.preview.close();
    app.review.setOpen(false);
    setSection(null);
    setBrowserSessions((current) => ({
      ...current,
      [scope]: openBrowserTab(current[scope] ?? EMPTY_BROWSER_TABS, url),
    }));
  };
  const openFile = (target: LocalFileTarget) => {
    hideBrowser();
    setSection("files");
    app.review.setOpen(false);
    void app.preview.openFile(target);
  };
  const select = (view: WorkbenchView) => {
    if (active === view) return;
    close();
    if (view === "browser") {
      if (app.client.mode === "remote")
        setRemoteBrowserSession(app.catalog.currentSessionId);
      else if (activeBrowserTab)
        setBrowserSessions((current) => ({
          ...current,
          [scope]: { ...(current[scope] ?? EMPTY_BROWSER_TABS), open: true },
        }));
      else newBrowserTab();
    } else if (view === "review") {
      setSection(view);
      app.review.setOpen(true);
    } else if (view === "files") {
      setSection(view);
      app.preview.reopen();
    } else setSection(view);
  };
  const openUrl = (url: string) => {
    if (app.client.mode === "remote") {
      if (/^https?:\/\//i.test(url))
        void openExternalUrl(url).catch((error) => app.setError(String(error)));
    } else newBrowserTab(url);
  };
  useBrowserDriverEvents(app.client, browserSessions, setBrowserSessions);
  useEffect(() => {
    const adoptDraft = (event: Event) => {
      const detail = (event as CustomEvent<BrowserDraftCreatedDetail>).detail;
      if (
        !detail ||
        typeof detail.workspaceId !== "string" ||
        typeof detail.sessionId !== "string"
      )
        return;
      flushSync(() =>
        setBrowserSessions((current) =>
          adoptDraftBrowserTabs(current, detail.workspaceId, detail.sessionId),
        ),
      );
    };
    window.addEventListener(BROWSER_DRAFT_CREATED_EVENT, adoptDraft);
    return () =>
      window.removeEventListener(BROWSER_DRAFT_CREATED_EVENT, adoptDraft);
  }, []);
  useEffect(() => {
    const openFromObservation = (event: Event) => {
      const detail = (event as CustomEvent<{ url?: unknown; tabId?: unknown }>)
        .detail;
      if (
        typeof detail?.url !== "string" ||
        !detail.url.trim() ||
        app.client.mode === "remote"
      )
        return;
      const url = detail.url;
      app.preview.close();
      app.review.setOpen(false);
      setSection(null);
      setBrowserSessions((current) => {
        const state = current[scope] ?? EMPTY_BROWSER_TABS;
        const tab =
          typeof detail.tabId === "string"
            ? state.tabs.find((item) => item.viewId === detail.tabId)
            : undefined;
        return {
          ...current,
          [scope]: tab
            ? { ...state, activeId: tab.id, open: true }
            : openBrowserTab(state, url),
        };
      });
    };
    window.addEventListener("miniq:open-browser", openFromObservation);
    return () =>
      window.removeEventListener("miniq:open-browser", openFromObservation);
  }, [scope, app.client, app.preview.close, app.review.setOpen]);

  return {
    scope,
    active,
    browserSessions,
    browserState,
    browserUrl,
    remoteBrowserOpen,
    hasBrowsers: Object.values(browserSessions).some(
      (state) => state.tabs.length,
    ),
    close,
    hideBrowser,
    select,
    openFile,
    openUrl,
    newBrowserTab,
    selectBrowserTab: (id: string) =>
      setBrowserSessions((current) => ({
        ...current,
        [scope]: { ...(current[scope] ?? EMPTY_BROWSER_TABS), activeId: id },
      })),
    closeBrowserTab: (id: string) =>
      setBrowserSessions((current) => ({
        ...current,
        [scope]: closeBrowserTab(current[scope] ?? EMPTY_BROWSER_TABS, id),
      })),
    navigateBrowser: (tabScope: string, id: string, url: string) =>
      setBrowserSessions((current) => ({
        ...current,
        [tabScope]: updateBrowserTab(
          current[tabScope] ?? EMPTY_BROWSER_TABS,
          id,
          url,
        ),
      })),
  };
}

export type AppWorkbenchController = ReturnType<typeof useAppWorkbench>;
