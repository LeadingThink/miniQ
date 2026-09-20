// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import type {
  AppWorkbenchController,
  WorkbenchView,
} from "../hooks/useAppWorkbench";
import { AppWorkbench } from "./AppWorkbench";

vi.mock("./BrowserPanel", () => ({
  BrowserPanel: (props: {
    viewId: string;
    active: boolean;
    onDiscuss: (url: string) => void;
  }) => (
    <section hidden={!props.active}>
      <iframe title={`page-${props.viewId}`} />
      <button onClick={() => props.onDiscuss("https://example.test/form")}>
        讨论网页
      </button>
    </section>
  ),
}));
vi.mock("./WorkbenchOverview", () => ({
  WorkbenchOverview: () => <p>概览内容</p>,
}));
vi.mock("./FilePreviewPanel", () => ({
  FilePreviewPanel: (props: {
    onDiscuss: (path: string, text: string) => void;
  }) => (
    <button
      onClick={() => props.onDiscuss("/project/report.md", "完整选区\n第二行")}
    >
      讨论选区
    </button>
  ),
}));
let viewport = 1400;
beforeEach(() => {
  viewport = 1400;
  vi.spyOn(window, "innerWidth", "get").mockImplementation(() => viewport);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => viewport,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 264,
  } as DOMRect);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function setup(active: WorkbenchView = "browser") {
  const app = {
    client: { mode: "local" },
    navigation: {},
    catalog: {
      currentSessionId: "session",
      currentWorkspace: { path: "/project" },
      currentWorkspacePaths: ["/project"],
    },
    preview: {
      tabs: [],
      state: { open: true },
      closeTab: vi.fn(),
      closeOtherTabs: vi.fn(),
    },
    review: { data: { files: [] } },
    feed: {},
    actions: {},
  } as unknown as MiniqAppController;
  const tab = { id: "one", viewId: "stable", url: "https://example.test/form" };
  const browserState = { tabs: [tab], activeId: "one", open: true };
  const workbench = {
    scope: "session",
    active,
    hasBrowsers: true,
    browserUrl: tab.url,
    browserState,
    browserSessions: { session: browserState },
    close: vi.fn(),
    select: vi.fn(),
    newBrowserTab: vi.fn(),
    selectBrowserTab: vi.fn(),
    closeBrowserTab: vi.fn(),
  } as unknown as AppWorkbenchController;
  return { app, workbench };
}
function layout(props: ReturnType<typeof setup>, onDiscuss = vi.fn()) {
  return (
    <div className="app">
      <div className="sidebar" />
      <AppWorkbench {...props} onDiscuss={onDiscuss} />
    </div>
  );
}

it("preserves the actual page element while switching modes and expanding", async () => {
  const props = setup();
  const view = render(layout(props));
  const frame = await screen.findByTitle("page-stable");
  fireEvent.click(screen.getByRole("button", { name: "展开工作面板" }));
  expect(
    view.container
      .querySelector(".workbench-panel")
      ?.getAttribute("data-expanded"),
  ).toBe("true");
  expect(screen.getByTitle("page-stable")).toBe(frame);
  view.rerender(
    layout({ ...props, workbench: { ...props.workbench, active: "overview" } }),
  );
  expect(await screen.findByText("概览内容")).toBeTruthy();
  expect(screen.getByTitle("page-stable")).toBe(frame);
  view.rerender(layout(props));
  expect(screen.getByTitle("page-stable")).toBe(frame);
});

it("restores split view when discussing from fullscreen, preserving all selected text", async () => {
  const props = setup("files");
  const discuss = vi.fn();
  const view = render(layout(props, discuss));
  await screen.findByText("讨论选区");
  fireEvent.click(screen.getByRole("button", { name: "展开工作面板" }));
  fireEvent.click(screen.getByText("讨论选区"));
  expect(
    view.container
      .querySelector(".workbench-panel")
      ?.hasAttribute("data-expanded"),
  ).toBe(false);
  expect(props.workbench.close).not.toHaveBeenCalled();
  expect(discuss).toHaveBeenCalledWith(
    "关于文件「/project/report.md」：\n\n选中内容：\n> 完整选区\n> 第二行\n\n修改要求：",
  );
});

it("hides narrow desktop overlays so the discussion draft remains accessible", async () => {
  viewport = 800;
  const props = setup();
  const discuss = vi.fn();
  render(layout(props, discuss));
  fireEvent.click(await screen.findByText("讨论网页"));
  expect(props.workbench.close).toHaveBeenCalledOnce();
  expect(discuss).toHaveBeenCalledWith(
    "关于网页 https://example.test/form：\n",
  );
});

it("keeps local project file previews available before creating a session", () => {
  const props = setup("overview");
  props.app.catalog.currentSessionId = null;
  render(layout(props));
  expect(
    (screen.getByRole("tab", { name: "文件" }) as HTMLButtonElement).disabled,
  ).toBe(false);
  expect(
    (screen.getByRole("tab", { name: "审阅" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
