// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { AppStatusBar } from "./AppStatus";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function appFixture(collapsed = true) {
  return {
    client: { mode: "local", sshHost: null },
    connection: {
      connected: true,
      phase: "connected",
      health: { daemonVersion: "test" },
    },
    navigation: {
      sidebarCollapsed: collapsed,
      setSidebarCollapsed: vi.fn(),
      setShowSettings: vi.fn(),
    },
    catalog: { currentSession: null },
    actions: { openSession: vi.fn() },
    preview: { viewScope: "test" },
    feed: { messages: [] },
    busy: false,
    review: { data: { files: [] } },
    setError: vi.fn(),
  } as unknown as MiniqAppController;
}

describe("AppStatusBar", () => {
  it("keeps a visible hover hint for every collapsed-layout icon action", () => {
    render(
      <AppStatusBar
        app={appFixture()}
        onOpenBrowser={() => {}}
        onToggleReview={() => {}}
        onOpenFile={() => {}}
        onToggleWorkbench={() => {}}
        workbenchOpen={false}
      />,
    );

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("data-tooltip"))).toEqual([
      "显示侧栏（⌘/Ctrl+B）",
      "待审批总览",
      "检查器：概览、审阅、预览和浏览器",
      "更多操作",
    ]);
    for (const button of buttons) {
      expect(button.getAttribute("title")).toBe(button.getAttribute("data-tooltip"));
      expect(button.getAttribute("aria-label")).toBeTruthy();
    }
  });

  it("renders a single draggable toolbar and keeps secondary actions in the overflow menu", () => {
    const onOpenBrowser = vi.fn();
    const app = appFixture();
    const { container } = render(
      <AppStatusBar
        app={app}
        onOpenBrowser={onOpenBrowser}
        onToggleReview={() => {}}
        onOpenFile={() => {}}
        onToggleWorkbench={() => {}}
        workbenchOpen
      />,
    );
    expect(container.querySelector(".statusbar")?.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(screen.getByRole("button", { name: "隐藏检查器" }).getAttribute("aria-pressed")).toBe("true");
    const more = screen.getByRole("button", { name: "更多操作" });
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const menu = screen.getByRole("menu", { name: "更多操作" });
    expect(menu.textContent).toContain("设置");
    fireEvent.click(screen.getByRole("menuitem", { name: "打开内置浏览器" }));
    expect(onOpenBrowser).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "设置" }));
    expect(app.navigation.setShowSettings).toHaveBeenCalledWith(true);
  });
});
