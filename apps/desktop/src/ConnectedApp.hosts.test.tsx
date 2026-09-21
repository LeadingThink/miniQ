// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ConnectedApp from "./ConnectedApp";
import { DesktopHostProvider } from "./desktopHost";
import { SshFixtureRoot } from "./fixtures/sshModel";
import type { MiniqAppController } from "./hooks/useMiniqApp";
import type { Session, Workspace } from "./types";
import { DEFAULT_MODEL_SETTINGS } from "./modelSelection";

vi.mock("@capacitor/app", () => ({ App: { addListener: () => Promise.resolve({ remove: vi.fn() }) } }));
vi.mock("./rpc", async (original) => ({ ...await original<typeof import("./rpc")>(), resolveConnection: vi.fn().mockResolvedValue({ kind: "local", port: 1, token: "fixture" }) }));
const notifyTaskResult = vi.hoisted(() => vi.fn());
vi.mock("./taskNotifications", () => ({ notifyTaskResult }));
const updater = vi.hoisted(() => ({ state: { phase: "idle" }, supported: false, checkNow: vi.fn(), install: vi.fn() }));
vi.mock("./hooks/useAppUpdater", () => ({ useAppUpdater: () => updater }));
vi.mock("./localFiles", async (original) => ({ ...await original<typeof import("./localFiles")>(), readLocalFilePreview: async (path: string, _workspace: unknown, _paths: unknown, options: { client: { sshHost: string | null } }) => ({ path, content: `${options.client.sshHost ?? "local"} file contents`, kind: "text", mimeType: "text/plain", dataBase64: null, size: 10 }) }));
vi.mock("./components/AppShell", () => ({ AppShell: ({ app, active }: { app: MiniqAppController; active: boolean }) => <section aria-label={`content-${app.client.sshHost ?? "local"}`} data-active={String(active)}>
  <p>{app.feed.messages.map((message) => message.content).join(" ")}</p>
  <p data-testid={`preview-${app.client.sshHost ?? "local"}`}>{app.preview.state.content ?? "no preview"}</p>
  <button onClick={() => void app.preview.openFile({ path: "/demo/project/result.txt", line: null, column: null })}>preview file</button>
  <span data-testid={`error-${app.client.sshHost ?? "local"}`}>{app.error}</span>
  <button onClick={() => void app.actions.createBlankProject("New project")}>create project from main</button>
  <button onClick={() => void app.actions.createSession("same-workspace")}>create session from main</button>
  <button disabled={!app.sessionModel.ready} onClick={() => void app.actions.startTask("A local task")}>start task</button>
</section> }));

class IntegrationRoot extends SshFixtureRoot {
  opened: string[] = [];
  extraWorkspaces: Workspace[] = [];
  extraSessions: Session[] = [];
  sendGate?: Promise<void>;
  override async content<T>(host: string | null, method: string, params?: unknown): Promise<T> {
    const p = params as { workspaceId?: string; sessionId?: string; name?: string };
    const label = host ?? "local";
    if (method === "workspace.list") { const result = await super.content<{ workspaces: Workspace[] }>(host, method); return { workspaces: [...result.workspaces, ...this.extraWorkspaces] } as T; }
    if (method === "session.list") { const result = await super.content<{ sessions: Session[] }>(host, method); return { sessions: [...result.sessions, ...this.extraSessions] } as T; }
    if (method === "workspace.create") {
      const workspace = { id: "created-workspace", path: "/demo/new", additionalPaths: [], name: p.name!, createdAt: "2026-09-20", updatedAt: "2026-09-20" }; this.extraWorkspaces.push(workspace); return workspace as T;
    }
    if (method === "session.create") {
      const session: Session = { id: "created-session", workspaceId: p.workspaceId!, workingDirectory: "/demo/project", title: "New main content session", status: "idle", pinned: false, archived: false, createdAt: "2026-09-20", updatedAt: "2026-09-20" }; this.extraSessions.push(session); return session as T;
    }
    if (method === "session.sendMessage") { await this.sendGate; return {} as T; }
    if (method === "session.open") {
      this.opened.push(label);
      const { sessions } = await this.content<{ sessions: Session[] }>(host, "session.list");
      return { session: sessions.find((session) => session.id === p.sessionId), messages: [{ id: "same-message", sessionId: p.sessionId, role: "assistant", content: `${label} private answer`, createdAt: "2026-09-20" }], toolCalls: [], artifacts: [], plan: [], queue: [], approvals: [], questions: [], streamingText: "", turnProgress: null } as T;
    }
    if (method === "session.modelGet" || method === "workspace.modelGet") return { settings: DEFAULT_MODEL_SETTINGS, effective: { model: "demo-model", apiProtocol: "auto", reasoningEffort: null } } as T;
    if (method === "session.diff") return { files: [], additions: 0, deletions: 0 } as T;
    return super.content<T>(host, method, params);
  }
}
afterEach(cleanup);
beforeEach(() => { localStorage.clear(); notifyTaskResult.mockClear(); Element.prototype.scrollIntoView = vi.fn(); });

it("loads equal session IDs from the selected computer and isolates actual preview state", async () => {
  const root = new IntegrationRoot(); const select = vi.spyOn(root, "selectSession");
  render(<DesktopHostProvider root={root}><ConnectedApp theme="jade" onThemeChange={() => {}} /></DesktopHostProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "本地产品 · 任务进度" }));
  await screen.findByText("local private answer");
  fireEvent.click(within(screen.getByRole("region", { name: "content-local" })).getByText("preview file"));
  await screen.findByText("local file contents");
  fireEvent.click(screen.getByRole("button", { name: "开发项目 · 任务进度" }));
  await waitFor(() => {
    const section = screen.queryByRole("region", { name: "content-demo-development" });
    expect({ opened: root.opened, visible: section?.textContent }).toEqual({ opened: expect.arrayContaining(["demo-development"]), visible: expect.stringContaining("demo-development private answer") });
  });
  expect(screen.queryByText("local private answer")?.closest("section")?.getAttribute("data-active")).toBe("false");
  expect(screen.getByTestId("preview-demo-development").textContent).toBe("no preview");
  fireEvent.click(within(screen.getByRole("region", { name: "content-demo-development" })).getByText("preview file"));
  await screen.findByText("demo-development file contents");
  fireEvent.click(screen.getByRole("button", { name: "研究项目 · 任务进度" }));
  await screen.findByText("demo-research private answer");
  expect(screen.queryByText("demo-development private answer")).toBeNull();
  expect(screen.getByTestId("preview-demo-research").textContent).toBe("no preview");
  expect(root.opened).toContain("local"); expect(root.opened).toContain("demo-development"); expect(root.opened).toContain("demo-research");
  expect(select).toHaveBeenLastCalledWith("same-session", "demo-research");
  fireEvent.click(screen.getByRole("button", { name: "开发项目 · 任务进度" }));
  await screen.findByText("demo-development private answer");
  await screen.findByText("demo-development file contents");
  fireEvent.click(screen.getByRole("button", { name: "本地产品 · 任务进度" }));
  await waitFor(() => expect(screen.getByRole("region", { name: "content-local" }).getAttribute("data-active")).toBe("true"));
  expect(screen.getByTestId("preview-local").textContent).toBe("local file contents");
});

it("updates the shared sidebar when main content creates a project or session", async () => {
  const root = new IntegrationRoot();
  render(<DesktopHostProvider root={root}><ConnectedApp theme="jade" onThemeChange={() => {}} /></DesktopHostProvider>);
  await screen.findByRole("button", { name: "本地产品 · 任务进度" });
  fireEvent.click(screen.getByText("create project from main"));
  await screen.findByRole("button", { name: "New project" });
  fireEvent.click(screen.getByText("create session from main"));
  await screen.findByRole("button", { name: "New main content session" });
});

it("finishes sending a local task without reopening its session after switching hosts", async () => {
  const root = new IntegrationRoot();
  let finish!: () => void;
  root.sendGate = new Promise<void>((resolve) => { finish = resolve; });
  const call = vi.spyOn(root, "call"); const select = vi.spyOn(root, "selectSession");
  render(<DesktopHostProvider root={root}><ConnectedApp theme="jade" onThemeChange={() => {}} /></DesktopHostProvider>);
  await screen.findByRole("button", { name: "本地产品 · 任务进度" });
  const start = screen.getByRole("button", { name: "start task" });
  await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(start);
  await waitFor(() => expect(call.mock.calls.some(([method]) => method === "session.sendMessage")).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "开发项目 · 任务进度" }));
  await screen.findByText("demo-development private answer");
  await act(async () => { finish(); await root.sendGate; });
  await waitFor(() => expect(select).toHaveBeenLastCalledWith("same-session", "demo-development"));
  expect(root.opened).not.toContain("local");
  expect(root.extraSessions).toHaveLength(1);
});

it("notifies once when a task on an inactive SSH host completes after switching hosts", async () => {
  const root = new IntegrationRoot();
  render(<DesktopHostProvider root={root}><ConnectedApp theme="jade" onThemeChange={() => {}} /></DesktopHostProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "开发项目 · 任务进度" }));
  await screen.findByText("demo-development private answer");
  fireEvent.click(screen.getByRole("button", { name: "研究项目 · 任务进度" }));
  await screen.findByText("demo-research private answer");
  await act(async () => {
    root.emit({ type: "host_event", hostId: "demo-development", event: { type: "turn_completed", sessionId: "same-session" } });
  });
  expect(notifyTaskResult.mock.calls).toEqual([["completed", "开发服务器 · 开发项目 · 任务进度"]]);
  await act(async () => {
    root.emit({ type: "host_event", hostId: "demo-research", event: { type: "turn_failed", sessionId: "same-session", error: "provider secret" } });
  });
  expect(notifyTaskResult).toHaveBeenLastCalledWith("failed", "研究服务器 · 研究项目 · 任务进度");
  expect(notifyTaskResult).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("region", { name: "content-demo-research" })).toBeTruthy();
});
