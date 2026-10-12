// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { SessionDiff } from "../types";
import { useSessionDiff } from "./useSessionDiff";

afterEach(cleanup);
const empty: SessionDiff = { files: [], additions: 0, deletions: 0 };

function deferred() {
  let resolve!: (value: SessionDiff) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<SessionDiff>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it("defers full and turn diff RPCs until the session body finishes loading", async () => {
  const call = vi.fn().mockResolvedValue(empty);
  const client = { call } as unknown as RpcClient;
  const hook = renderHook(({ ready }) => useSessionDiff(client, "a", [], "turn", ready), { initialProps: { ready: false } });
  act(() => hook.result.current.showTurn("turn"));
  await act(async () => hook.result.current.refresh());
  expect(call).not.toHaveBeenCalled();
  await act(async () => hook.rerender({ ready: true }));
  expect(call).toHaveBeenCalledTimes(2);
  expect(call).toHaveBeenCalledWith("session.diff", { sessionId: "a" }, { signal: expect.any(AbortSignal) });
  expect(call).toHaveBeenCalledWith("session.diff", { sessionId: "a", scope: "turn", turnId: "turn" }, { signal: expect.any(AbortSignal) });
});

it("cancels both diff scopes on a session switch and discards late results", async () => {
  const oldSession = deferred();
  const oldTurn = deferred();
  const call = vi.fn().mockReturnValueOnce(oldSession.promise).mockReturnValueOnce(oldTurn.promise).mockResolvedValue(empty);
  const client = { call } as unknown as RpcClient;
  const hook = renderHook(({ id }) => useSessionDiff(client, id, [], "turn"), { initialProps: { id: "a" } });
  act(() => hook.result.current.showTurn("turn"));
  const sessionSignal = call.mock.calls[0][2].signal;
  const turnSignal = call.mock.calls[1][2].signal;
  await act(async () => hook.rerender({ id: "b" }));
  expect(sessionSignal.aborted).toBe(true);
  expect(turnSignal.aborted).toBe(true);
  await act(async () => {
    oldSession.resolve({ ...empty, additions: 999 });
    oldTurn.reject(new Error("old turn failure"));
  });
  expect(hook.result.current.data).toEqual(empty);
  expect(hook.result.current.view.diff).toEqual(empty);
  expect(hook.result.current.error).toBeNull();
  expect(hook.result.current.view.error).toBeNull();
});

it("cancels on host changes even when the session ID is identical", async () => {
  const old = deferred();
  const firstCall = vi.fn().mockReturnValue(old.promise);
  const secondCall = vi.fn().mockResolvedValue({ ...empty, additions: 2 });
  const first = { call: firstCall } as unknown as RpcClient;
  const second = { call: secondCall } as unknown as RpcClient;
  const hook = renderHook(({ client }) => useSessionDiff(client, "same", []), { initialProps: { client: first } });
  await act(async () => hook.rerender({ client: second }));
  expect(firstCall.mock.calls[0][2].signal.aborted).toBe(true);
  await act(async () => old.resolve({ ...empty, additions: 1 }));
  expect(hook.result.current.data.additions).toBe(2);
});

it("aborts on disable and unmount without surfacing cancellation errors", async () => {
  const old = deferred();
  const next = deferred();
  const call = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  const client = { call } as unknown as RpcClient;
  const hook = renderHook(({ enabled }) => useSessionDiff(client, "a", [], null, enabled), { initialProps: { enabled: true } });
  hook.rerender({ enabled: false });
  expect(call.mock.calls[0][2].signal.aborted).toBe(true);
  await act(async () => old.reject(new Error("cancelled")));
  expect(hook.result.current.error).toBeNull();
  hook.rerender({ enabled: true });
  hook.unmount();
  expect(call.mock.calls[1][2].signal.aborted).toBe(true);
  await act(async () => next.resolve(empty));
});

it("keeps session totals while reviewing a turn and refreshes both after restoration", async () => {
  const session = { ...empty, additions: 2 };
  const turn = { ...empty, additions: 1 };
  const call = vi.fn(async (_method: string, params: { scope?: string }) => params.scope === "turn" ? turn : session);
  const client = { call } as unknown as RpcClient;
  const hook = renderHook(() => useSessionDiff(client, "a", [], "latest"));
  await act(async () => {});
  expect(hook.result.current.data).toEqual(session);
  await act(async () => hook.result.current.showTurn("selected", "a.ts"));
  expect(hook.result.current.view.diff).toEqual(turn);
  expect(hook.result.current.data).toEqual(session);
  expect(hook.result.current.focus?.path).toBe("a.ts");
  expect(call).toHaveBeenCalledWith("session.diff", { sessionId: "a", scope: "turn", turnId: "selected" }, { signal: expect.any(AbortSignal) });
  act(() => hook.result.current.showSession());
  expect(hook.result.current.view.diff).toEqual(session);
  await act(async () => hook.result.current.setScope("turn"));
  expect(call).toHaveBeenCalledWith("session.diff", { sessionId: "a", scope: "turn", turnId: "latest" }, { signal: expect.any(AbortSignal) });
  const before = call.mock.calls.length;
  await act(async () => hook.result.current.filesRestored());
  expect(call).toHaveBeenCalledTimes(before + 2);
});
