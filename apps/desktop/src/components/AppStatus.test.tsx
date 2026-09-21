// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
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
      "任务、文件、网页和审阅",
      "打开内置浏览器",
    ]);
    for (const button of buttons) {
      expect(button.getAttribute("title")).toBe(button.getAttribute("data-tooltip"));
      expect(button.getAttribute("aria-label")).toBeTruthy();
    }
  });
});
