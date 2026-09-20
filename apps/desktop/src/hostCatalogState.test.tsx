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
    <output data-testid="state">{catalog?.state}</output>
    <output data-testid="unread">{catalog?.unreadSessionIds.size}</output>
    <output data-testid="session-status">{catalog?.sessions[0]?.status}</output>
    <output data-testid="selected-host">{host.host ?? "local"}</output>
    <output data-testid="ready-epoch">{host.connection.connectionEpoch}</output>
    <output data-testid="local-projects">{host.catalogs[hostKey(null)]?.workspaces.length}</output>
    <output data-testid="local-error">{host.catalogs[hostKey(null)]?.error}</output>
    <button onClick={() => host.markSeen(HOST, "same-session")}>seen</button>
    <button onClick={() => void host.refreshCatalog(HOST)}>refresh</button>
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
