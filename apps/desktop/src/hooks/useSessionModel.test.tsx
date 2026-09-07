// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSessionModel } from "./useSessionModel";
import {
  DEFAULT_MODEL_SETTINGS,
  type SessionModelResult,
} from "../modelSelection";
import type { DaemonEvent } from "../types";
import type { RpcClient } from "../rpc";

afterEach(cleanup);
const result = (model: string): SessionModelResult => ({
  settings: { ...DEFAULT_MODEL_SETTINGS, model },
  effective: { model, apiProtocol: "auto", reasoningEffort: null },
});

function fakeClient(call: ReturnType<typeof vi.fn>) {
  const events = new Set<(event: DaemonEvent) => void>();
  const client = {
    call,
    connected: true,
    onStatus: () => () => {},
    onEvent: (listener: (event: DaemonEvent) => void) => {
      events.add(listener);
      return () => events.delete(listener);
    },
  } as unknown as RpcClient;
  return {
    client,
    emit: (event: DaemonEvent) => events.forEach((listener) => listener(event)),
  };
}

it("ignores stale model loads after switching sessions", async () => {
  let resolveA!: (value: SessionModelResult) => void;
  const call = vi.fn((_method, params) =>
    params.sessionId === "a"
      ? new Promise<SessionModelResult>((done) => {
          resolveA = done;
        })
      : Promise.resolve(result("model-b"))
  );
  const { client } = fakeClient(call);
  const hook = renderHook(({ id }) => useSessionModel(client, id), {
    initialProps: { id: "a" },
  });
  hook.rerender({ id: "b" });
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  await act(async () => {
    resolveA(result("model-a"));
  });
  expect(hook.result.current.effective?.model).toBe("model-b");
});

it("reloads only this session on model-change broadcasts", async () => {
  const call = vi.fn().mockResolvedValue(result("one"));
  const { client, emit } = fakeClient(call);
  const hook = renderHook(() => useSessionModel(client, "a"));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  act(() =>
    emit({
      type: "model_settings_changed",
      sessionId: "b",
      settings: DEFAULT_MODEL_SETTINGS,
    })
  );
  expect(call).toHaveBeenCalledTimes(1);
  call.mockResolvedValue(result("two"));
  act(() =>
    emit({
      type: "model_settings_changed",
      sessionId: "a",
      settings: DEFAULT_MODEL_SETTINGS,
    })
  );
  await waitFor(() => expect(hook.result.current.effective?.model).toBe("two"));
});

it("keeps new-session model choices local instead of changing the global provider", async () => {
  const call = vi
    .fn()
    .mockResolvedValue({ provider: result("global").effective });
  const { client } = fakeClient(call);
  const hook = renderHook(() => useSessionModel(client, null));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  await act(async () =>
    hook.result.current.update({
      ...DEFAULT_MODEL_SETTINGS,
      model: "custom-oneapi-id",
    })
  );
  expect(hook.result.current.effective?.model).toBe("custom-oneapi-id");
  expect(call.mock.calls.every(([method]) => method === "settings.get")).toBe(
    true
  );
});

it("does not display an old session's update failure in the newly selected session", async () => {
  let reject!: (cause: Error) => void;
  const call = vi.fn((method, params) =>
    method === "session.modelUpdate"
      ? new Promise((_done, fail) => {
          reject = fail;
        })
      : Promise.resolve(result(params.sessionId))
  );
  const { client } = fakeClient(call);
  const hook = renderHook(({ id }) => useSessionModel(client, id), {
    initialProps: { id: "a" },
  });
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  let pending!: Promise<void>;
  act(() => {
    pending = hook.result.current
      .update(DEFAULT_MODEL_SETTINGS)
      .catch(() => {});
  });
  hook.rerender({ id: "b" });
  await waitFor(() => expect(hook.result.current.effective?.model).toBe("b"));
  await act(async () => {
    reject(new Error("a failed"));
    await pending;
  });
  expect(hook.result.current.error).toBeNull();
});

it("shows a new-session protocol override even when the model is inherited", async () => {
  const call = vi.fn().mockResolvedValue({
    provider: {
      model: "global",
      apiProtocol: "responses",
      reasoningEffort: null,
    },
  });
  const { client } = fakeClient(call);
  const hook = renderHook(() => useSessionModel(client, null));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  expect(hook.result.current.effective?.apiProtocol).toBe("responses");
  await act(async () =>
    hook.result.current.update({
      ...DEFAULT_MODEL_SETTINGS,
      apiProtocol: "chat_completions",
    })
  );
  expect(hook.result.current.effective).toEqual({
    model: "global",
    apiProtocol: "chat_completions",
    reasoningEffort: null,
  });
  await act(async () => hook.result.current.update(DEFAULT_MODEL_SETTINGS));
  expect(hook.result.current.effective?.apiProtocol).toBe("responses");
});

it("hides the previous model and error while the next session is loading", async () => {
  let resolveB!: (value: SessionModelResult) => void;
  const call = vi.fn((method, params) => {
    if (method === "session.modelUpdate")
      return Promise.reject(new Error("A configuration failed"));
    if (params.sessionId === "a") return Promise.resolve(result("model-a"));
    return new Promise<SessionModelResult>((resolve) => {
      resolveB = resolve;
    });
  });
  const { client } = fakeClient(call);
  const hook = renderHook(({ id }) => useSessionModel(client, id), {
    initialProps: { id: "a" },
  });
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  await act(async () => {
    await hook.result.current.update(DEFAULT_MODEL_SETTINGS).catch(() => {});
  });
  expect(hook.result.current.error).toContain("A configuration failed");
  hook.rerender({ id: "b" });
  expect(hook.result.current.error).toBeNull();
  expect(hook.result.current.effective).toBeNull();
  expect(hook.result.current.settings.model).toBeNull();
  await act(async () => {
    resolveB(result("model-b"));
  });
  expect(hook.result.current.effective?.model).toBe("model-b");
});

it("does not let another session's pending update block or finish the current update", async () => {
  const complete = new Map<string, (value: SessionModelResult) => void>();
  const call = vi.fn((method, params) =>
    method === "session.modelUpdate"
      ? new Promise<SessionModelResult>((resolve) => {
          complete.set(params.sessionId, resolve);
        })
      : Promise.resolve(result(params.sessionId))
  );
  const { client } = fakeClient(call);
  const hook = renderHook(({ id }) => useSessionModel(client, id), {
    initialProps: { id: "a" },
  });
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  let updateA!: Promise<void>;
  let updateB!: Promise<void>;
  act(() => {
    updateA = hook.result.current.update(DEFAULT_MODEL_SETTINGS);
  });
  hook.rerender({ id: "b" });
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  expect(hook.result.current.pending).toBe(false);
  act(() => {
    updateB = hook.result.current.update(DEFAULT_MODEL_SETTINGS);
  });
  expect(hook.result.current.pending).toBe(true);
  await act(async () => {
    complete.get("a")!(result("updated-a"));
    await updateA;
  });
  expect(hook.result.current.pending).toBe(true);
  expect(hook.result.current.effective?.model).toBe("b");
  await act(async () => {
    complete.get("b")!(result("updated-b"));
    await updateB;
  });
  expect(hook.result.current.pending).toBe(false);
  expect(hook.result.current.effective?.model).toBe("updated-b");
});
