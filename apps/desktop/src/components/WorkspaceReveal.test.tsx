// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const project = {
  id: "project-b", name: "目标项目", path: "/work/项目 B", additionalPaths: ["/work/shared"],
  createdAt: "2026-09-03T00:00:00Z", updatedAt: "2026-09-03T00:00:00Z",
};
const noop = () => undefined;

function setup(overrides: Partial<ComponentProps<typeof Sidebar>> = {}) {
  const onError = vi.fn();
  render(<Sidebar
    workspaces={[project]} sessions={[]} unreadSessionIds={new Set()} currentSessionId={null}
    selectedWorkspaceId={null} onNewChat={noop} onShowSearch={noop} onShowSchedule={noop}
    onImportSessions={noop} onSelectWorkspace={noop} onCreateSession={noop} onDeleteWorkspace={noop}
    onRenameWorkspace={noop} onEditWorkspace={noop} onSelectSession={noop} onSessionSeen={noop}
    onDeleteSession={noop} onRenameSession={noop} onSetSessionPinned={noop} onSetSessionArchived={noop}
    onShowSettings={noop} updateSupported={false}
    updateState={{ phase: "idle", version: null, downloadedBytes: 0, totalBytes: null, error: null, busyReason: null, releaseNotes: [] }}
    onCheckForUpdates={noop} onInstallUpdate={noop} onError={onError} {...overrides}
  />);
  fireEvent.click(screen.getByRole("button", { name: "目标项目 的更多操作" }));
  return { onError };
}

function desktop(platform: string) {
  vi.stubGlobal("__TAURI_INTERNALS__", { invoke });
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  invoke.mockResolvedValue(undefined);
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  invoke.mockReset();
});

it.each([
  ["MacIntel", "在 Finder 中显示"],
  ["Win32", "在文件资源管理器中显示"],
  ["Linux x86_64", "在文件管理器中显示"],
])("reveals the project without a session on %s", async (platform, label) => {
  desktop(platform);
  const { onError } = setup();
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
  await waitFor(() => expect(invoke).toHaveBeenCalledExactlyOnceWith("reveal_local_file", {
    path: project.path, workspacePath: project.path, workspacePaths: project.additionalPaths, authorizedFiles: [],
  }));
  expect(onError).not.toHaveBeenCalled();
  expect(screen.queryByRole("menu")).toBeNull();
});

it("uses the clicked project rather than the active session's project", async () => {
  desktop("MacIntel");
  const other = { ...project, id: "project-a", name: "当前项目", path: "/work/a", additionalPaths: [] };
  setup({ workspaces: [other, project], selectedWorkspaceId: other.id, currentSessionId: "session-a", sessions: [{
    id: "session-a", workspaceId: other.id, workingDirectory: other.path, title: "当前会话",
    status: "idle", pinned: false, archived: false, createdAt: other.createdAt, updatedAt: other.updatedAt,
  }] });
  fireEvent.click(screen.getByRole("menuitem", { name: "在 Finder 中显示" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("reveal_local_file", {
    path: project.path, workspacePath: project.path, workspacePaths: project.additionalPaths, authorizedFiles: [],
  }));
});

it("reports native failures without replacing them with a missing-session error", async () => {
  desktop("MacIntel");
  invoke.mockRejectedValueOnce(new Error("目录不存在"));
  const { onError } = setup();
  fireEvent.click(screen.getByRole("menuitem", { name: "在 Finder 中显示" }));
  await waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith("目录不存在"));
});

it("hides local reveal for remote-host projects even in the desktop app", () => {
  desktop("Win32");
  setup({ hostGroups: [{ key: "remote", label: "远程电脑", state: "connected", local: false,
    workspaceIds: [project.id], selected: true, onSelect: noop }] });
  expect(screen.queryByRole("menuitem", { name: /在.*中显示/ })).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});

it.each(["iPhone", "Linux armv8l", "Win32"])("does not expose Tauri reveal in a non-Tauri %s WebView or browser", (platform) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  setup();
  expect(screen.queryByRole("menuitem", { name: /在.*中显示/ })).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});