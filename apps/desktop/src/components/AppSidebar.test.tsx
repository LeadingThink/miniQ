// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { AppSidebar } from "./AppSidebar";

vi.mock("./Sidebar", () => ({ Sidebar: (props: {
  onSelectWorkspace: (id: string) => void;
  onSelectSession: (id: string) => void;
  onCreateSession: (id: string) => void;
}) => <div>
  <button onClick={() => props.onSelectWorkspace("project")}>展开项目</button>
  <button onClick={() => props.onSelectSession("session")}>打开会话</button>
  <button onClick={() => props.onCreateSession("project")}>创建会话</button>
</div> }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function controller() {
  return {
    catalog: { workspaces: [], sessions: [] }, unreadSessionIds: new Set(),
    navigation: { setSidebarCollapsed: vi.fn(), sidebarCollapsed: false },
    updater: { supported: false, state: {} }, setError: vi.fn(),
    actions: { selectWorkspace: vi.fn(), openSession: vi.fn().mockResolvedValue(undefined), createSession: vi.fn().mockResolvedValue(undefined) },
  } as unknown as MiniqAppController;
}

describe("AppSidebar mobile navigation", () => {
  it("keeps the drawer open when expanding a project and closes it after opening a session", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const app = controller();
    render(<AppSidebar app={app} />);
    fireEvent.click(screen.getByRole("button", { name: "展开项目" }));
    expect(app.actions.selectWorkspace).toHaveBeenCalledWith("project");
    expect(app.navigation.setSidebarCollapsed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "打开会话" }));
    expect(app.actions.openSession).toHaveBeenCalledWith("session");
    expect(app.navigation.setSidebarCollapsed).toHaveBeenCalledWith(true);
  });

  it("closes the drawer after creating a session on the chosen host", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const app = controller();
    const onCreateSession = vi.fn();
    render(<AppSidebar app={app} onCreateSession={onCreateSession} />);
    fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
    expect(onCreateSession).toHaveBeenCalledWith("project");
    expect(app.actions.createSession).not.toHaveBeenCalled();
    expect(app.navigation.setSidebarCollapsed).toHaveBeenCalledWith(true);
  });

  it("keeps the desktop sidebar visible while opening or creating sessions", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    const app = controller();
    render(<AppSidebar app={app} />);
    fireEvent.click(screen.getByRole("button", { name: "打开会话" }));
    fireEvent.click(screen.getByRole("button", { name: "创建会话" }));
    expect(app.actions.createSession).toHaveBeenCalledWith("project");
    expect(app.navigation.setSidebarCollapsed).not.toHaveBeenCalled();
  });
});
