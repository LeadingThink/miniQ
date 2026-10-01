// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesktopHostProvider, useDesktopHost } from "./desktopHost";
import { SshFixtureRoot } from "./fixtures/sshModel";
import { hostKey } from "./hostWorkspace";
import type { Session, SessionStatus } from "./types";

vi.mock("@capacitor/app", () => ({ App: { addListener: () => Promise.resolve({ remove: vi.fn() }) } }));
vi.mock("./rpc", async (original) => ({ ...await original<typeof import("./rpc")>(), resolveConnection: vi.fn().mockResolvedValue({ kind: "local", port: 1, token: "fixture" }) }));
const HOST = "demo-development";

class CatalogRoot extends SshFixtureRoot {
  status: SessionStatus = "idle";
  delayed: (() => void) | null = null;
  hold = false;
  override async content<T>(host: string | null, method: string, params?: unknown): Promise<T> {
    const result = await super.content<T>(host, method, params);
    if (host === HOST && method === "session.list") {
      if (this.hold) {
        this.hold = false;
        await new Promise<void>((resolve) => { this.delayed = resolve; });
      }
      return { sessions: (result as { sessions: Session[] }).sessions.map((session) => ({ ...session, status: this.status })) } as T;
    }
    return result;
  }
  change(status: SessionStatus) {
    this.status = status;
    this.emit({ type: "host_event", hostId: HOST, event: { type: "session_status_changed", sessionId: "same-session", status } });
  }
}

function State() {
  const host = useDesktopHost()!;
  const catalog = host.catalogs[hostKey(HOST)];
  return <>
    <output data-testid="catalog-status">{catalog?.catalogStatus}</output>
    <output data-testid="catalog-error">{catalog?.catalogError}</output>
    <output data-testid="offline-status">{host.catalogs[hostKey("demo-offline")]?.catalogStatus}</output>
    <output data-testid="local-status">{host.catalogs[hostKey(null)]?.catalogStatus}</output>
    <output data-testid="state">{catalog?.state}</output>
    <output data-testid="unread">{catalog?.unreadSessionIds.size}</output>
    <output data-testid="session-status">{catalog?.sessions[0]?.status}</output>
    <output data-testid="selected-host">{host.host ?? "local"}</output>
    <output data-testid="ready-epoch">{host.connection.connectionEpoch}</output>
    <output data-testid="local-projects">{host.catalogs[hostKey(null)]?.workspaces.length}</output>
    <output data-testid="local-error">{host.catalogs[hostKey(null)]?.error}</output>
    <button onClick={() => void host.removeHost(HOST)}>remove</button>
    <button onClick={() => host.markSeen(HOST, "same-session")}>seen</button>
    <button onClick={() => void host.refreshCatalog(HOST).catch(() => {})}>refresh</button>
    <button onClick={() => void host.selectHost("demo-research")}>research</button>
  </>;
}
async function setup() {
  const root = new CatalogRoot();
  render(<DesktopHostProvider root={root}><State /></DesktopHostProvider>);
  await waitFor(() => expect(screen.getByTestId("session-status").textContent).toBe("idle"));
  return root;
}
afterEach(cleanup);
beforeEach(() => localStorage.clear());

it("only marks finished work unread, not empty sessions or repeated idle acknowledgements", async () => {
  const root = await setup();
  await act(async () => root.change("idle"));
  expect(screen.getByTestId("unread").textContent).toBe("0");
  await act(async () => root.change("running"));
  await waitFor(() => expect(screen.getByTestId("session-status").textContent).toBe("running"));
  await act(async () => root.change("idle"));
  expect(screen.getByTestId("unread").textContent).toBe("1");
  fireEvent.click(screen.getByText("seen"));
  await act(async () => root.change("idle"));
  expect(screen.getByTestId("unread").textContent).toBe("0");
  await act(async () => root.emit({ type: "host_event", hostId: HOST, event: { type: "turn_completed", sessionId: "same-session" } }));
  expect(screen.getByTestId("unread").textContent).toBe("1");
});

it("a delayed catalog response cannot turn a disconnected host back online", async () => {
  const root = await setup();
  root.hold = true;
  fireEvent.click(screen.getByText("refresh"));
  await waitFor(() => expect(root.delayed).not.toBeNull());
  await act(async () => { await root.call("host.disconnect", { hostId: HOST }); });
  await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("disconnected"));
  expect(screen.getByTestId("catalog-status").textContent).toBe("idle");
  await act(async () => { root.delayed!(); });
  expect(screen.getByTestId("state").textContent).toBe("disconnected");
});

it("a slow catalog does not delay switching to another healthy host", async () => {
  const root = await setup();
  root.hold = true;
  fireEvent.click(screen.getByText("refresh"));
  await waitFor(() => expect(root.delayed).not.toBeNull());
  await act(async () => { await root.call("host.disconnect", { hostId: "demo-research" }); });
  fireEvent.click(screen.getByText("research"));
  await waitFor(() => expect(screen.getByTestId("selected-host").textContent).toBe("demo-research"));
  await act(async () => { root.delayed!(); });
  expect(screen.getByTestId("selected-host").textContent).toBe("demo-research");
});

it.each(["unknown method: host.list (code -32601)", "SSH 主机配置格式无效"])("keeps the local daemon ready when SSH metadata fails: %s", async (failure) => {
  const root = new CatalogRoot();
  const original = root.call.bind(root);
  const calls = vi.spyOn(root, "call").mockImplementation(async (method, params) => {
    if (method === "host.list") throw new Error(failure);
    return original(method, params);
  });
  render(<DesktopHostProvider root={root}><State /></DesktopHostProvider>);
  await waitFor(() => expect(screen.getByTestId("ready-epoch").textContent).toBe("1"));
  expect(screen.getByTestId("local-projects").textContent).toBe("1");
  expect(screen.getByTestId("local-error").textContent).toContain(failure);
  expect(calls.mock.calls.filter(([method]) => method === "host.list")).toHaveLength(1);
});


it("shows initial local loading and leaves disconnected SSH catalogs idle", async () => {
  const root = new CatalogRoot();
  let release!: () => void;
  const original = root.content.bind(root);
  vi.spyOn(root, "content").mockImplementation(async (host, method, params) => {
    if (host === null && method === "workspace.list") await new Promise<void>((resolve) => { release = resolve; });
    return original(host, method, params);
  });
  render(<DesktopHostProvider root={root}><State /></DesktopHostProvider>);
  expect(screen.getByTestId("local-status").textContent).toBe("loading");
  await waitFor(() => expect(screen.getByTestId("offline-status").textContent).toBe("idle"));
  await act(async () => release());
  await waitFor(() => expect(screen.getByTestId("local-status").textContent).toBe("ready"));
});

it("keeps cached projects on a failed refresh and clears the error after a retry", async () => {
  const root = await setup();
  const original = root.content.bind(root);
  let fail = true;
  vi.spyOn(root, "content").mockImplementation(async (host, method, params) => {
    if (host === HOST && method === "workspace.list" && fail) throw new Error("目录读取失败");
    return original(host, method, params);
  });
  fireEvent.click(screen.getByText("refresh"));
  await waitFor(() => expect(screen.getByTestId("catalog-status").textContent).toBe("error"));
  expect(screen.getByTestId("catalog-error").textContent).toBe("目录读取失败");
  expect(screen.getByTestId("session-status").textContent).toBe("idle");
  fail = false;
  root.hold = true;
  fireEvent.click(screen.getByText("refresh"));
  await waitFor(() => expect(root.delayed).not.toBeNull());
  expect(screen.getByTestId("catalog-status").textContent).toBe("loading");
  await act(async () => root.delayed!());
  await waitFor(() => expect(screen.getByTestId("catalog-status").textContent).toBe("ready"));
  expect(screen.getByTestId("catalog-error").textContent).toBe("");
});

it.each([false, true])("removed hosts stay removed after a delayed request (reject=%s) and stale events", async (reject) => {
  const root = await setup();
  const original = root.content.bind(root);
  let finish!: () => void;
  vi.spyOn(root, "content").mockImplementation(async (host, method, params) => {
    if (host === HOST && method === "workspace.list") {
      await new Promise<void>((resolve) => { finish = resolve; });
      if (reject) throw new Error("late error");
    }
    return original(host, method, params);
  });
  fireEvent.click(screen.getByText("refresh"));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  fireEvent.click(screen.getByText("remove"));
  await waitFor(() => expect(screen.getByTestId("state").textContent).toBe(""));
  await act(async () => finish());
  await act(async () => root.emit({ type: "host_event", hostId: HOST, event: { type: "workspace_deleted", workspaceId: "same-workspace" } }));
  expect(screen.getByTestId("state").textContent).toBe("");
  expect(screen.getByTestId("catalog-status").textContent).toBe("");
});


it("records a first-load failure separately from an empty successful catalog", async () => {
  const root = new CatalogRoot();
  const original = root.content.bind(root);
  vi.spyOn(root, "content").mockImplementation(async (host, method, params) => {
    if (host === HOST && method === "workspace.list") throw new Error("initial failure");
    return original(host, method, params);
  });
  render(<DesktopHostProvider root={root}><State /></DesktopHostProvider>);
  await waitFor(() => expect(screen.getByTestId("catalog-status").textContent).toBe("error"));
  expect(screen.getByTestId("catalog-error").textContent).toBe("initial failure");
  expect(screen.getByTestId("session-status").textContent).toBe("");
  expect(screen.getByTestId("local-status").textContent).toBe("ready");
});
