// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { RemoteDeviceBarContext } from "../remoteDeviceBar";
import { AppErrorBanner, AppStatusBar } from "./AppStatus";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function appFixture(collapsed = true, mode: "local" | "remote" = "local") {
  return {
    client: { mode, sshHost: null },
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

describe("AppErrorBanner", () => {
  it("guides a disconnected remote user to the computer dropdown and removes the guidance after reconnect", () => {
    const app = {
      ...appFixture(true, "remote"),
      error: "所选桌面设备不存在，miniQ 正在自动重连",
      dismissError: vi.fn(),
    };
    const bar = { name: "电脑A", online: false, devices: [], selected: null, loading: false, error: null, onSelect: vi.fn(), onRefresh: vi.fn(), onSwitch: vi.fn() };
    const banner = (connected: boolean) => <RemoteDeviceBarContext.Provider value={bar}>
      <AppErrorBanner app={{ ...app, connection: { ...app.connection, connected } }} />
    </RemoteDeviceBarContext.Provider>;
    const view = render(banner(false));
    expect(screen.getByRole("alert").textContent).toContain(app.error);
    expect(screen.getByRole("alert").textContent).toContain("可点击顶部电脑名称旁的下拉箭头，手动切换电脑。");
    fireEvent.click(screen.getByRole("button", { name: "连接设置" }));
    expect(app.navigation.setShowSettings).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "关闭错误提示" }));
    expect(app.dismissError).toHaveBeenCalledOnce();
    view.rerender(banner(true));
    expect(screen.queryByText(/手动切换电脑/)).toBeNull();
    expect(screen.queryByRole("button", { name: "连接设置" })).toBeNull();
  });

  it("does not suggest a computer dropdown when none is available", () => {
    const app = appFixture(true, "remote");
    render(<AppErrorBanner app={{ ...app, error: "连接已断开", connection: { ...app.connection, connected: false } }} />);
    expect(screen.queryByText(/手动切换电脑/)).toBeNull();
  });
});

describe("AppStatusBar", () => {
  it("places the phone session menu before reminders and opens the current summary from it", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const app = appFixture(true, "remote");
    app.catalog.currentSession = { id: "phone-session", title: "真机会话", status: "idle" } as NonNullable<typeof app.catalog.currentSession>;
    const dispatch = vi.spyOn(window, "dispatchEvent");
    const { container } = render(<AppStatusBar app={app} showAttentionInbox
      onOpenBrowser={vi.fn()} onToggleReview={vi.fn()} onOpenFile={vi.fn()} onToggleWorkbench={vi.fn()} />);
    const actions = within(container.querySelector<HTMLElement>(".app-toolbar-actions")!);
    expect(actions.getAllByRole("button").map((button) => button.getAttribute("aria-label")))
      .toEqual(["会话操作", "提醒", "显示检查器", "更多操作"]);
    const trigger = actions.getByRole("button", { name: "会话操作" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "会话摘要" }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      type: "miniq:session-toolbar-action", detail: { sessionId: "phone-session", action: "summary" },
    }));
    expect(screen.queryByRole("menuitem", { name: "会话摘要" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("shows an icon side-conversation entry and invokes its toggle", () => {
    const onToggleSideConversation = vi.fn();
    render(
      <AppStatusBar
        app={appFixture()}
        sideConversationOpen={false}
        onToggleSideConversation={onToggleSideConversation}
        onOpenBrowser={() => {}}
        onToggleReview={() => {}}
        onOpenFile={() => {}}
      />,
    );

    const trigger = screen.getByRole("button", { name: "打开侧边聊天" });
    expect(trigger.textContent?.trim()).toBe("");
    fireEvent.click(trigger);
    expect(onToggleSideConversation).toHaveBeenCalledOnce();
  });

  it("offers side chat from the overflow menu", () => {
    const onToggleSideConversation = vi.fn();
    render(
      <AppStatusBar
        app={appFixture()}
        sideConversationOpen={false}
        onToggleSideConversation={onToggleSideConversation}
        onOpenBrowser={vi.fn()}
        onToggleReview={vi.fn()}
        onOpenFile={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "更多操作" }));
    const menu = screen.getByRole("menu", { name: "更多操作" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "侧边聊天" }));
    expect(onToggleSideConversation).toHaveBeenCalledOnce();
  });

  it("keeps four remote home actions including a working inspector entry", () => {
    const onToggleWorkbench = vi.fn();
    const onToggleReview = vi.fn();
    const { container } = render(
      <AppStatusBar
        app={appFixture(true, "remote")}
        onOpenBrowser={vi.fn()}
        onToggleReview={onToggleReview}
        onOpenFile={vi.fn()}
        onToggleWorkbench={onToggleWorkbench}
        showAttentionInbox
      />,
    );

    const actions = within(
      container.querySelector<HTMLElement>(".app-toolbar-actions")!,
    );
    expect(
      actions.getAllByRole("button").map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "提醒",
      "显示检查器",
      "更多操作",
    ]);
    const inspector = actions.getByRole("button", { name: "显示检查器" });
    expect(inspector.title).toContain("审阅");
    fireEvent.click(inspector);
    expect(onToggleWorkbench).toHaveBeenCalledOnce();
    expect(onToggleReview).not.toHaveBeenCalled();
  });

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

  it("runs all remote overflow actions and closes the portal menu", () => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.open = true; });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.open = false; });
    const onSwitch = vi.fn();
    const onSwitchMode = vi.fn();
    const onAppearance = vi.fn();
    const dispatch = vi.spyOn(window, "dispatchEvent");
    const app = appFixture(true, "remote");
    render(
      <RemoteDeviceBarContext.Provider value={{ name: "电脑A", online: true, devices: [], selected: null, loading: false, error: null, onSelect: vi.fn(), onRefresh: vi.fn(), onSwitch, onSwitchMode, onAppearance }}>
        <AppStatusBar
          app={app}
          onOpenBrowser={() => {}}
          onToggleReview={() => {}}
          onOpenFile={() => {}}
          onToggleWorkbench={() => {}}
          workbenchOpen={false}
        />
      </RemoteDeviceBarContext.Provider>,
    );

    const more = screen.getByRole("button", { name: "更多操作" });
    for (const label of ["切换电脑", "切换用途", "连接详情", "外观"]) {
      fireEvent.click(more);
      fireEvent.click(screen.getByRole("menuitem", { name: label }));
    }

    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitchMode).toHaveBeenCalledTimes(1);
    expect(onAppearance).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "miniq:remote-connection-details" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("places session search in the session actions menu and keeps share and diagnostics in the overflow menu", () => {
    const app = {
      ...appFixture(true, "remote"),
      catalog: {
        currentSession: { id: "s1", title: "测试会话", status: "idle", workspaceId: "w1", createdAt: "", updatedAt: "" },
        currentWorkspace: { id: "w1", name: "项目", path: "/w1", additionalPaths: [], createdAt: "", updatedAt: "" },
      },
    } as unknown as MiniqAppController;
    const received: Array<{ sessionId?: string; action: string }> = [];
    const onAction = (event: Event) => {
      received.push((event as CustomEvent<{ sessionId?: string; action: string }>).detail);
    };
    window.addEventListener("miniq:session-toolbar-action", onAction);
    const { container } = render(
      <AppStatusBar
        app={app}
        onOpenBrowser={() => {}}
        onToggleReview={() => {}}
        onOpenFile={() => {}}
        onToggleWorkbench={() => {}}
        showAttentionInbox
      />,
    );
    const actions = within(container.querySelector<HTMLElement>(".app-toolbar-actions")!);
    expect(actions.queryByRole("button", { name: "搜索和筛选会话" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "会话操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /搜索和筛选会话/ }));
    const more = actions.getByRole("button", { name: "更多操作" });
    fireEvent.click(more);
    const menu = screen.getByRole("menu", { name: "更多操作" });
    expect(menu.textContent).not.toContain("导出 Markdown");
    expect(menu.textContent).not.toContain("导出 JSON");
    fireEvent.click(screen.getByRole("menuitem", { name: "分享会话" }));
    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: "模型调用记录" }));
    window.removeEventListener("miniq:session-toolbar-action", onAction);
    expect(received).toEqual([
      { sessionId: "s1", action: "search" },
      { sessionId: "s1", action: "share" },
      { sessionId: "s1", action: "diagnostics" },
    ]);
  });
});
