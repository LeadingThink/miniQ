// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostEvent, RpcClient } from "../rpc";
import type { Approval, DaemonEvent, Question, Session } from "../types";
import { emptyCatalog, hostKey, type HostCatalog } from "../hostWorkspace";
import { useAttentionNotifications } from "./useAttentionNotifications";

const notifyAttention = vi.hoisted(() => vi.fn());
vi.mock("../taskNotifications", () => ({ notifyAttention }));
vi.mock("../runtime", () => ({ isTauriRuntime: () => false }));
beforeEach(() => { notifyAttention.mockReset().mockResolvedValue(true); });
afterEach(cleanup);

const approval = (id: string, status: Approval["status"] = "pending") => ({ id, sessionId: "s1", toolCallId: "t", riskLevel: "medium", status, reason: "运行 npm install", createdAt: "" }) as Approval;
const question = (id: string) => ({ id, sessionId: "s1", toolCallId: "t", prompt: "选择哪个方案？", options: [], createdAt: "" }) as Question;
const approvalEvent = (id: string, status?: Approval["status"]) => ({ type: "approval_requested", sessionId: "s1", approval: approval(id, status), toolName: "shell", input: {}, riskLevel: "medium" }) as DaemonEvent;

function setup(focusFallback = false) {
  const local = new Set<(event: DaemonEvent) => void>();
  const hosts = new Set<(event: HostEvent) => void>();
  const root = {
    onEvent: vi.fn((listener: (event: DaemonEvent) => void) => { local.add(listener); return () => { local.delete(listener); }; }),
    onHostEvent: vi.fn((listener: (event: HostEvent) => void) => { hosts.add(listener); return () => { hosts.delete(listener); }; }),
  } as unknown as RpcClient;
  const catalogs: Record<string, HostCatalog> = {
    [hostKey(null)]: { ...emptyCatalog(null, "本机"), state: "connected", sessions: [{ id: "s1", workspaceId: "w1", title: "修复构建" } as Session] },
    [hostKey("alpha")]: { ...emptyCatalog("alpha", "开发电脑"), state: "connected", sessions: [{ id: "s1", workspaceId: "w9", title: "远程任务" } as Session] },
  };
  const navigate = vi.fn();
  const hook = renderHook(() => useAttentionNotifications(root, catalogs, navigate, focusFallback));
  const emit = async (host: string | null, event: DaemonEvent) => {
    await act(async () => {
      if (host === null) local.forEach((listener) => listener(event));
      else hosts.forEach((listener) => listener({ type: "host_event", hostId: host, event } as HostEvent));
      await Promise.resolve();
    });
  };
  return { emit, navigate, hook, local, hosts };
}

it("notifies approvals and questions once per request id with the session title", async () => {
  const { emit } = setup();
  await emit(null, approvalEvent("a1"));
  await emit(null, approvalEvent("a1"));
  await emit(null, { type: "question_requested", sessionId: "s1", question: question("q1") } as DaemonEvent);
  await emit(null, { type: "question_requested", sessionId: "s1", question: question("q1") } as DaemonEvent);
  expect(notifyAttention).toHaveBeenCalledTimes(2);
  expect(notifyAttention.mock.calls[0].slice(0, 3)).toEqual(["approval", "修复构建", "运行 npm install"]);
  expect(notifyAttention.mock.calls[1].slice(0, 3)).toEqual(["question", "修复构建", "选择哪个方案？"]);
});

it("scopes dedupe per host and labels remote sessions", async () => {
  const { emit } = setup();
  await emit(null, approvalEvent("a1"));
  await emit("alpha", approvalEvent("a1"));
  expect(notifyAttention).toHaveBeenCalledTimes(2);
  expect(notifyAttention.mock.calls[1][1]).toBe("开发电脑 · 远程任务");
});

it("ignores already-resolved approvals and unrelated events", async () => {
  const { emit } = setup();
  await emit(null, approvalEvent("a2", "approved"));
  await emit(null, { type: "turn_completed", sessionId: "s1" } as DaemonEvent);
  expect(notifyAttention).not.toHaveBeenCalled();
});

it("navigates to the session when the notification is clicked", async () => {
  const { emit, navigate } = setup();
  await emit("alpha", approvalEvent("a1"));
  const onClick = notifyAttention.mock.calls[0][3] as () => void;
  onClick();
  expect(navigate).toHaveBeenCalledWith("alpha", { workspaceId: "w9", sessionId: "s1" });
});

it("does not navigate for a request that was already resolved", async () => {
  const { emit, navigate } = setup();
  await emit(null, { type: "question_requested", sessionId: "s1", question: question("q1") } as DaemonEvent);
  await emit(null, { type: "question_resolved", sessionId: "s1", questionId: "q1", answer: "A" } as DaemonEvent);
  (notifyAttention.mock.calls[0][3] as () => void)();
  expect(navigate).not.toHaveBeenCalled();
});

it("uses the next window focus as the native click fallback, once", async () => {
  const { emit, navigate } = setup(true);
  await emit(null, approvalEvent("a1"));
  await act(async () => { await Promise.resolve(); });
  window.dispatchEvent(new Event("focus"));
  window.dispatchEvent(new Event("focus"));
  expect(navigate).toHaveBeenCalledTimes(1);
  expect(navigate).toHaveBeenCalledWith(null, { workspaceId: "w1", sessionId: "s1" });
});

it("skips the focus fallback when the approval resolved first or nothing was sent", async () => {
  const { emit, navigate } = setup(true);
  await emit(null, approvalEvent("a1"));
  await emit(null, { type: "approval_resolved", sessionId: "s1", approval: approval("a1", "approved") } as DaemonEvent);
  window.dispatchEvent(new Event("focus"));
  notifyAttention.mockResolvedValue(false);
  await emit(null, approvalEvent("a3"));
  window.dispatchEvent(new Event("focus"));
  expect(navigate).not.toHaveBeenCalled();
});

it("unsubscribes on unmount", async () => {
  const { hook, local, hosts } = setup(true);
  hook.unmount();
  expect(local.size).toBe(0);
  expect(hosts.size).toBe(0);
});
