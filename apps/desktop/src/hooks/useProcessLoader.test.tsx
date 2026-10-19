// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { withProcessPage, withoutKeys } from "../processRecords";
import type { RpcClient } from "../rpc";
import type { HistoryPage } from "../types";
import { useProcessLoader } from "./useProcessLoader";

const page = (nextCursor: HistoryPage["nextCursor"], ids: string[]): HistoryPage => ({
  messages: [],
  toolCalls: ids.map((id) => ({ id, sessionId: "s", toolName: "x", input: null, status: "succeeded", createdAt: "t" })),
  nextCursor,
});

function setup(call: ReturnType<typeof vi.fn>) {
  const mergeProcess = vi.fn();
  const feed = { loading: false, processLoads: {}, mergeProcess };
  const client = { call } as unknown as RpcClient;
  const epoch = { current: 1 };
  const hook = renderHook(() => useProcessLoader(client, "s", epoch, feed));
  return { hook, mergeProcess, epoch };
}

it("shares one in-flight request per turn and sends the turn id", async () => {
  let release!: (value: HistoryPage) => void;
  const call = vi.fn(() => new Promise<HistoryPage>((resolve) => { release = resolve; }));
  const { hook, mergeProcess } = setup(call);
  let first!: Promise<unknown>;
  await act(async () => {
    first = hook.result.current("u1");
    expect(hook.result.current("u1")).toBe(first);
  });
  expect(call).toHaveBeenCalledOnce();
  expect(call.mock.calls[0].slice(0, 2)).toEqual(["session.processRecords", { sessionId: "s", turnId: "u1" }]);
  await act(async () => { release(page(null, ["a"])); await first; });
  expect(mergeProcess).toHaveBeenCalledWith("s", "u1", expect.objectContaining({ nextCursor: null }));
});

it("resolves failures as an error result and allows a retry", async () => {
  const call = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue(page(null, []));
  const { hook, mergeProcess } = setup(call);
  let result: unknown;
  await act(async () => { result = await hook.result.current(null); });
  expect(result).toEqual({ error: expect.any(Error) });
  expect(mergeProcess).not.toHaveBeenCalled();
  expect(call.mock.calls[0][1]).toEqual({ sessionId: "s" });
  await act(async () => { await hook.result.current(null); });
  expect(mergeProcess).toHaveBeenCalledOnce();
});

it("tracks loaded counts and completion per fold", () => {
  let loads = withProcessPage({}, "u1", page({ at: "t", id: "x" }, ["a", "b"]));
  expect(loads.u1).toEqual({ loaded: 2, cursor: { at: "t", id: "x" }, complete: false });
  loads = withProcessPage(loads, "u1", page(null, ["c"]));
  expect(loads.u1).toEqual({ loaded: 3, cursor: null, complete: true });
  expect(withoutKeys(loads, ["u1"])).toEqual({});
  expect(withoutKeys(loads, ["zz"])).toBe(loads);
});
