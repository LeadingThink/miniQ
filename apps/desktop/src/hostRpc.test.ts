import { expect, it, vi } from "vitest";
import { RpcClient, type HostEvent } from "./rpc";
import { HostRpcClient } from "./hostRpc";

function setup() {
  const root = new RpcClient();
  const listeners = new Set<(event: HostEvent) => void>();
  vi.spyOn(root, "onHostEvent").mockImplementation((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; });
  vi.spyOn(root, "connected", "get").mockReturnValue(true);
  vi.spyOn(root, "call").mockResolvedValue({ ok: true });
  vi.spyOn(root, "connect").mockResolvedValue();
  vi.spyOn(root, "disconnect"); vi.spyOn(root, "selectSession");
  return { root, a: new HostRpcClient(root, "a"), b: new HostRpcClient(root, "b"), emit: (event: HostEvent) => listeners.forEach((listener) => listener(event)) };
}
it("routes commands through the existing root and never reconnects its healthy socket", async () => {
  const { root, a } = setup();
  await a.connect({ kind: "local", port: 9000, token: "fixture" });
  expect(root.connect).not.toHaveBeenCalled();
  const signal = new AbortController().signal;
  await a.call("session.open", { sessionId: "same" }, { signal });
  expect(root.call).toHaveBeenLastCalledWith("host.call", { hostId: "a", method: "session.open", params: { sessionId: "same" } }, { signal });
  a.disconnect(); expect(root.disconnect).not.toHaveBeenCalled();
  a.selectSession("same"); expect(root.selectSession).toHaveBeenCalledWith("same", "a");
});
it("isolates equal session IDs and remote resync by host", () => {
  const { a, b, emit } = setup(); const one = vi.fn(), two = vi.fn(), resyncA = vi.fn(), resyncB = vi.fn();
  a.onEvent(one); b.onEvent(two); a.onResync(resyncA); b.onResync(resyncB);
  emit({ type: "host_event", hostId: "a", event: { type: "session_deleted", sessionId: "same" } });
  expect(one).toHaveBeenCalledOnce(); expect(two).not.toHaveBeenCalled();
  emit({ type: "host_event", hostId: "b", event: { type: "remote_resync" } });
  expect(resyncA).not.toHaveBeenCalled(); expect(resyncB).toHaveBeenCalledOnce();
  expect(two).not.toHaveBeenCalled();
});
it("one host becoming unavailable does not disconnect the root or another host", () => {
  const { root, a, b } = setup(); const status = vi.fn(); a.onStatus(status);
  a.setAvailable(false); expect(status).toHaveBeenCalledWith(false);
  expect(a.connected).toBe(false); expect(b.connected).toBe(true); expect(root.disconnect).not.toHaveBeenCalled();
});
