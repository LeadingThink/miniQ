// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import type { DaemonEvent } from "../types";
import { DEFAULT_MODEL_SETTINGS } from "../modelSelection";

vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("../hooks/useAppSlashCommands", () => ({ useAppSlashCommands: () => ({ commands: [], dialogs: null }) }));
vi.mock("./AppStatus", () => ({ AppStatusBar: () => null, AppErrorBanner: () => null }));
vi.mock("./Timeline", () => ({ Timeline: () => null }));

beforeEach(() => {
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(1400);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1400);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 380, height: 800 } as DOMRect);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("opens the real side chat from /btw and sends against the current main session", async () => {
  const listeners = new Set<(event: DaemonEvent) => void>();
  const side = { id: "side", workspaceId: "w", workingDirectory: "/work", title: "侧聊", status: "idle" };
  const call = vi.fn(async (method: string) => {
    if (method === "session.fork") return side;
    if (method === "session.open") return {
      session: side, messages: [],
      toolCalls: [], artifacts: [], plan: [], turnPlans: [], queue: [],
      approvals: [], questions: [], streamingText: "", streamingReasoning: "",
      turnProgress: null, goal: null, lastTurn: null, latestTurnTiming: null,
      processSummaries: [],
    };
    if (method === "agent.list") return { agents: [] };
    if (method === "skill.list") return { skills: [] };
    return {};
  });
  const app = {
    client: {
      mode: "local", sshHost: null, storageScope: "local", call,
      onEvent: (fn: (event: DaemonEvent) => void) => { listeners.add(fn); return () => listeners.delete(fn); },
      onStatus: () => () => {},
      onResync: () => () => {},
    },
    catalog: {
      currentSessionId: "main", currentSession: { id: "main", title: "主任务", workspaceId: "w", workingDirectory: "/work", status: "running" },
      selectedWorkspace: { id: "w", name: "项目", path: "/work", additionalPaths: [] },
      currentWorkspace: { id: "w", name: "项目", path: "/work", additionalPaths: [] },
      currentWorkspacePaths: ["/work"], workspaces: [], sessions: [],
    },
    navigation: { page: null, setShowSearch: vi.fn(), setShowSettings: vi.fn(), setPage: vi.fn(), setSidebarCollapsed: vi.fn() },
    preview: { state: { open: false }, tabs: [], close: vi.fn() },
    review: { data: { files: [] }, setOpen: vi.fn(), epoch: 0, filesRestored: vi.fn() },
    actions: { newChat: vi.fn(), cancelTurn: vi.fn(), sendMessage: vi.fn(), companionVoiceHandled: vi.fn() },
    sessionModel: {
      pending: false, ready: true, error: null, settings: DEFAULT_MODEL_SETTINGS, effective: null,
      describe: vi.fn(), list: vi.fn(async () => []), reload: vi.fn(), update: vi.fn(),
      performance: vi.fn(),
    },
    connection: { providerConfigured: true }, busy: false,
    feed: { messages: [], toolCalls: [], artifacts: [], queue: [], loading: false },
    companionVoiceRequest: null, setError: vi.fn(),
  } as unknown as MiniqAppController;
  render(<AppShell app={app} theme="jade" onThemeChange={() => {}} contentOnly active />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: /随心输入|消息/ });
  fireEvent.change(input, { target: { value: "/btw 解释这个报错" } });
  await act(async () => fireEvent.keyDown(input, { key: "Enter" }));

  expect(await screen.findByRole("complementary", { name: "侧边聊天" })).toBeTruthy();
  await waitFor(() => expect(call).toHaveBeenCalledWith("session.fork", { sessionId: "main", mode: "side" }));
  await waitFor(() => expect(call).toHaveBeenCalledWith("session.sendMessage", {
    sessionId: "side", message: { role: "user", content: "解释这个报错", attachments: [] }, rejectIfBusy: true,
  }));
  expect(app.actions.sendMessage).not.toHaveBeenCalled();
});
