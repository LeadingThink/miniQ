// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useAppWorkbench } from "./useAppWorkbench";
import { useFilePreview } from "./useFilePreview";
import type { MiniqAppController } from "./useMiniqApp";
import type { RpcClient } from "../rpc";
import { readLocalFilePreview } from "../localFiles";
import { openExternalUrl } from "../externalLinks";

vi.mock("./useBrowserDriverEvents", () => ({
  useBrowserDriverEvents: vi.fn(),
}));
vi.mock("../localFiles", () => ({
  readLocalFilePreview: vi.fn(async (path: string) => ({
    path,
    content: "report",
    kind: "markdown",
    mimeType: "text/markdown",
    size: 6,
    dataBase64: null,
  })),
}));
vi.mock("../externalLinks", () => ({ openExternalUrl: vi.fn(async () => {}) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const paths = ["/project"];
const client = { mode: "local" } as RpcClient;
const target = { path: "/project/report.md", line: null, column: null };

function useHarness(session: string | null, remote = false) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const preview = useFilePreview("/project", session, paths, client);
  const app = {
    catalog: {
      currentSessionId: session,
      selectedWorkspace: { id: "project" },
    },
    preview,
    review: { open: reviewOpen, setOpen: setReviewOpen },
    client: remote ? { ...client, mode: "remote" } : client,
    setError: vi.fn(),
  } as unknown as MiniqAppController;
  return { workbench: useAppWorkbench(app), preview };
}

it("keeps native browser identities through file, review and overview navigation", async () => {
  const { result } = renderHook(() => useHarness("a"));
  act(() => result.current.workbench.openUrl("https://example.test/form"));
  const tab = result.current.workbench.browserState.tabs[0];
  expect(result.current.workbench.active).toBe("browser");
  await act(async () => result.current.workbench.openFile(target));
  expect(result.current.workbench.active).toBe("files");
  act(() => result.current.workbench.select("review"));
  expect(result.current.workbench.active).toBe("review");
  expect(result.current.preview.state.content).toBeNull();
  expect(result.current.preview.tabs).toEqual([target]);
  act(() => result.current.workbench.select("overview"));
  expect(result.current.workbench.active).toBe("overview");
  act(() => result.current.workbench.select("browser"));
  expect(result.current.workbench.browserState.tabs).toEqual([tab]);
  expect(result.current.workbench.browserUrl).toBe(tab.url);
  await act(async () => result.current.workbench.select("files"));
  expect(result.current.preview.state.content).toBe("report");
  vi.mocked(readLocalFilePreview).mockClear();
  act(() => result.current.workbench.select("files"));
  expect(readLocalFilePreview).not.toHaveBeenCalled();
});

it("keeps the files index available after the final file closes, and can undo", async () => {
  const { result } = renderHook(() => useHarness("a"));
  await act(async () => result.current.workbench.openFile(target));
  act(() => result.current.preview.closeAllTabs());
  expect(result.current.workbench.active).toBe("files");
  expect(result.current.preview.state.open).toBe(false);
  expect(result.current.preview.canReopenClosedTab).toBe(true);
  await act(async () => result.current.preview.reopenClosedTab());
  expect(result.current.preview.state.target).toEqual(target);
  act(() => result.current.workbench.close());
  expect(result.current.workbench.active).toBeNull();
  expect(result.current.preview.tabs).toHaveLength(1);
});

it("isolates browser tabs and selected sections between sessions", async () => {
  const { result, rerender } = renderHook(
    ({ session }) => useHarness(session),
    { initialProps: { session: "a" } },
  );
  act(() => result.current.workbench.openUrl("https://example.test/a"));
  act(() => result.current.workbench.select("overview"));
  rerender({ session: "b" });
  expect(result.current.workbench.active).toBeNull();
  expect(result.current.workbench.browserState.tabs).toHaveLength(0);
  act(() => result.current.workbench.openUrl("https://example.test/b"));
  rerender({ session: "a" });
  expect(result.current.workbench.active).toBe("overview");
  expect(
    result.current.workbench.browserState.tabs.map((tab) => tab.url),
  ).toEqual(["https://example.test/a"]);
});

it("remote browsing opens records without creating a local live browser", async () => {
  const { result } = renderHook(() => useHarness("remote", true));
  act(() => result.current.workbench.select("browser"));
  expect(result.current.workbench.remoteBrowserOpen).toBe(true);
  expect(result.current.workbench.hasBrowsers).toBe(false);
  act(() => result.current.workbench.openUrl("https://example.test"));
  expect(openExternalUrl).toHaveBeenCalledWith("https://example.test");
  act(() => result.current.workbench.openUrl("javascript:alert(1)"));
  expect(openExternalUrl).toHaveBeenCalledTimes(1);
  act(() => result.current.workbench.select("overview"));
  expect(result.current.workbench.remoteBrowserOpen).toBe(false);
});
