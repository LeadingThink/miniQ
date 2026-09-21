// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { DesktopHostProvider, useDesktopHost, hostDraftKey } from "./desktopHost";
import { SshFixtureRoot } from "./fixtures/sshModel";
const keepAwake = vi.hoisted(() => vi.fn());
vi.mock("./keepAwake", async (original) => ({ ...await original<typeof import("./keepAwake")>(), useKeepAwake: keepAwake }));
vi.mock("@capacitor/app", () => ({ App: { addListener: () => Promise.resolve({ remove: vi.fn() }) } }));
vi.mock("./rpc", async (original) => ({ ...await original<typeof import("./rpc")>(), resolveConnection: vi.fn().mockResolvedValue({ kind: "local", port: 1, token: "fixture" }) }));
afterEach(cleanup);
beforeEach(() => { localStorage.clear(); keepAwake.mockClear(); });
function Workspace() {
  const host = useDesktopHost()!; const [filter, setFilter] = useState("");
  return <><span data-testid="host">{host.host ?? "local"}</span><input aria-label="persistent sidebar filter" value={filter} onChange={(event) => setFilter(event.target.value)} />
    <button onClick={() => void host.selectHost("demo-development")}>dev</button><button onClick={() => void host.selectHost("demo-research")}>research</button><button onClick={() => void host.selectHost(null)}>local</button><button onClick={() => void host.selectHost("demo-offline")}>offline</button><button onClick={() => void host.selectHost("new-unsaved")}>new</button>
    <span data-testid="catalogs">{Object.values(host.catalogs).flatMap((catalog) => catalog.workspaces.map((workspace) => workspace.name)).join(",")}</span>
    {host.error && <span role="alert">{host.error}</span>}
  </>;
}
async function setup(root = new SshFixtureRoot()) {
  render(<DesktopHostProvider root={root}><Workspace /></DesktopHostProvider>);
  await waitFor(() => expect(screen.getByTestId("catalogs").textContent).toContain("研究项目"));
  return root;
}
it("retains simultaneous host catalogs and does not remount sidebar on switch", async () => {
  const root = await setup(); const disconnect = vi.spyOn(root, "disconnect");
  fireEvent.change(screen.getByLabelText("persistent sidebar filter"), { target: { value: "my search" } });
  fireEvent.click(screen.getByText("dev")); await waitFor(() => expect(screen.getByTestId("host").textContent).toBe("demo-development"));
  expect(screen.getByTestId("catalogs").textContent).toContain("本地产品");
  expect(screen.getByTestId("catalogs").textContent).toContain("研究项目");
  expect((screen.getByLabelText("persistent sidebar filter") as HTMLInputElement).value).toBe("my search");
  fireEvent.click(screen.getByText("local")); await waitFor(() => expect(screen.getByTestId("host").textContent).toBe("local"));
  expect(disconnect).not.toHaveBeenCalled();
  expect(hostDraftKey("a", "same")).not.toBe(hostDraftKey("b", "same"));
});
it("failed SSH preserves current host and sidebar state", async () => {
  await setup(); fireEvent.click(screen.getByText("offline"));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "演示主机暂不可达；本机及其他电脑保持连接");
  expect(screen.getByTestId("host").textContent).toBe("local");
});
it("returning local is not blocked by a slow SSH connection", async () => {
  const disconnected = new SshFixtureRoot();
  disconnected.hosts[0].state = "disconnected";
  const root = await setup(disconnected); const original = root.call.bind(root); let finish!: () => void;
  vi.spyOn(root, "call").mockImplementation(async (method, params) => {
    if (method === "host.connect") await new Promise<void>((resolve) => { finish = resolve; });
    return original(method, params);
  });
  fireEvent.click(screen.getByText("dev")); fireEvent.click(screen.getByRole("button", { name: "local" }));
  await act(async () => { finish(); });
  expect(screen.getByTestId("host").textContent).toBe("local");
});
it("reuses connected hosts without refetching every host catalog on navigation", async () => {
  const root = await setup(); const call = vi.spyOn(root, "call");
  fireEvent.click(screen.getByText("dev"));
  await waitFor(() => expect(screen.getByTestId("host").textContent).toBe("demo-development"));
  fireEvent.click(screen.getByText("research"));
  await waitFor(() => expect(screen.getByTestId("host").textContent).toBe("demo-research"));
  expect(call).not.toHaveBeenCalled();
});
it("mobile only connects saved desktop hosts and never saves arbitrary hosts", async () => {
  const root = new SshFixtureRoot(); root.mobile = true; const call = vi.spyOn(root, "call"); await setup(root);
  fireEvent.click(screen.getByText("new")); expect(await screen.findByRole("alert")).toHaveProperty("textContent", "请先在桌面端添加 SSH 电脑，移动端只能连接已保存的电脑");
  expect(call.mock.calls.some(([method]) => method === "host.save")).toBe(false);
  fireEvent.click(screen.getByText("dev")); await waitFor(() => expect(screen.getByTestId("host").textContent).toBe("demo-development"));
});
it("keeps legacy storage until every host has migrated, without blocking real catalogs", async () => {
  localStorage.setItem("miniq.ssh.saved-hosts", '["saved-a","saved-b"]');
  const root = new SshFixtureRoot(); const original = root.call.bind(root);
  vi.spyOn(root, "call").mockImplementation(async (method, params) => {
    if (method === "host.save" && (params as { hostId: string }).hostId === "saved-b") throw new Error("disk full");
    return original(method, params);
  });
  await setup(root); expect(localStorage.getItem("miniq.ssh.saved-hosts")).toBe('["saved-a","saved-b"]');
});
it("ignores malformed legacy preferences while retaining them for recovery", async () => {
  localStorage.setItem("miniq.ssh.saved-hosts", "broken json"); await setup();
  expect(localStorage.getItem("miniq.ssh.saved-hosts")).toBe("broken json");
});

it("retains the local task sleep lease while viewing SSH and never leases for a mobile viewer", async () => {
  const root = new SshFixtureRoot();
  const content = root.content.bind(root);
  vi.spyOn(root, "content").mockImplementation(async (host, method, params) => {
    if (host === null && method === "session.list") return { sessions: [
      { id: "idle", workspaceId: "same-workspace", status: "idle" },
      { id: "background", workspaceId: "same-workspace", status: "running" },
    ] };
    return content(host, method, params);
  });
  await setup(root);
  await waitFor(() => expect(keepAwake).toHaveBeenLastCalledWith(true));
  fireEvent.click(screen.getByText("dev"));
  await waitFor(() => expect(screen.getByTestId("host").textContent).toBe("demo-development"));
  expect(keepAwake).toHaveBeenLastCalledWith(true);
  cleanup();
  root.mobile = true;
  await setup(root);
  expect(keepAwake).toHaveBeenLastCalledWith(false);
});
