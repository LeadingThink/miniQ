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

it("reloads only the matching session on session-model broadcasts", async () => {
  const call = vi.fn().mockResolvedValue(result("one"));
  const { client, emit } = fakeClient(call);
  const hook = renderHook(() => useSessionModel(client, "a", "study"));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  act(() =>
    emit({
      type: "model_settings_changed",
      sessionId: "b",
      workspaceId: "other",
      settings: DEFAULT_MODEL_SETTINGS,
    })
  );
  expect(call).toHaveBeenCalledTimes(1);
  call.mockResolvedValue(result("two"));
  act(() =>
    emit({
      type: "model_settings_changed",
      sessionId: "a",
      workspaceId: "study",
      settings: DEFAULT_MODEL_SETTINGS,
    })
  );
  await waitFor(() => expect(hook.result.current.effective?.model).toBe("two"));
});

it("keeps existing sessions unchanged on workspace default broadcasts", async () => {
  const call = vi.fn().mockResolvedValue(result("one"));
  const { client, emit } = fakeClient(call);
  const hook = renderHook(() => useSessionModel(client, "a", "study"));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  call.mockResolvedValue(result("two"));

  act(() =>
    emit({
      type: "workspace_model_settings_changed",
      workspaceId: "study",
      settings: DEFAULT_MODEL_SETTINGS,
    })
  );

  expect(call).toHaveBeenCalledTimes(1);
  expect(hook.result.current.effective?.model).toBe("one");
});

it("keeps existing sessions unchanged on global default broadcasts", async () => {
  const call = vi.fn().mockResolvedValue(result("one"));
  const { client, emit } = fakeClient(call);
  const hook = renderHook(() => useSessionModel(client, "a", "study"));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  call.mockResolvedValue(result("global"));

  act(() =>
    emit({
      type: "global_model_settings_changed",
      settings: { ...DEFAULT_MODEL_SETTINGS, model: "global" },
    })
  );

  expect(call).toHaveBeenCalledTimes(1);
  expect(hook.result.current.effective?.model).toBe("one");
});

it("updates the global model from a project draft", async () => {
  let current = result("workspace-model");
  const call = vi.fn((method) =>
    Promise.resolve(method === "model.update"
      ? (current = result("updated-model"))
      : current)
  );
  const { client } = fakeClient(call);
  const hook = renderHook(() => useSessionModel(client, null, "study"));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  await act(async () =>
    hook.result.current.update({
      ...DEFAULT_MODEL_SETTINGS,
      model: "updated-model",
    })
  );
  expect(hook.result.current.effective?.model).toBe("updated-model");
  expect(call).toHaveBeenLastCalledWith("model.update", {
    settings: { ...DEFAULT_MODEL_SETTINGS, model: "updated-model" },
  });
  await act(async () => hook.result.current.reload());
  expect(hook.result.current.effective?.model).toBe("updated-model");
});

it("refreshes future defaults while existing session models stay independent", async () => {
  let defaults = result("deepseek");
  const sessions = new Map([["a", result("deepseek")], ["b", result("deepseek")]]);
  const call = vi.fn(async (method, params) => {
    if (method === "session.modelGet") return sessions.get(params.sessionId);
    if (method === "workspace.modelGet") return defaults;
    if (method === "model.update") {
      defaults = result(params.settings.model);
      if (params.sessionId) sessions.set(params.sessionId, defaults);
      return defaults;
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const { client, emit } = fakeClient(call);
  const a = renderHook(() => useSessionModel(client, "a", "study"));
  const b = renderHook(() => useSessionModel(client, "b", "study"));
  const draft = renderHook(() => useSessionModel(client, null, "study"));
  await waitFor(() => expect([a, b, draft].every((hook) => hook.result.current.ready)).toBe(true));
  await act(async () => b.result.current.update({ ...DEFAULT_MODEL_SETTINGS, model: "gpt" }));
  act(() => emit({ type: "global_model_settings_changed", settings: defaults.settings }));
  await waitFor(() => expect(draft.result.current.effective?.model).toBe("gpt"));
  expect(a.result.current.effective?.model).toBe("deepseek");
  expect(b.result.current.effective?.model).toBe("gpt");
  await act(async () => a.result.current.reload());
  expect(a.result.current.effective?.model).toBe("deepseek");
  expect(call).toHaveBeenCalledWith("model.update", {
    sessionId: "b", settings: { ...DEFAULT_MODEL_SETTINGS, model: "gpt" },
  });
});

it("updates the selected session and future defaults from an existing session", async () => {
  const call = vi.fn().mockResolvedValue(result("updated-model"));
  const { client } = fakeClient(call);
  const hook = renderHook(() => useSessionModel(client, "session-a", "study"));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));

  await act(async () => hook.result.current.update(DEFAULT_MODEL_SETTINGS));

  expect(call).toHaveBeenLastCalledWith("model.update", {
    sessionId: "session-a",
    settings: DEFAULT_MODEL_SETTINGS,
  });
});

it("loads legacy session settings without writing them back", async () => {
  const legacy: SessionModelResult = {
    settings: {
      model: "claude-sonnet-4.6",
      apiProtocol: "anthropic_messages",
      reasoningEffort: "high",
    },
    effective: {
      model: "claude-sonnet-4.6",
      apiProtocol: "anthropic_messages",
      reasoningEffort: "high",
    },
  };
  const call = vi.fn((method) => {
    if (method === "session.modelGet") return Promise.resolve(legacy);
    throw new Error(`unexpected method ${method}`);
  });
  const { client } = fakeClient(call);
  const hook = renderHook(() => useSessionModel(client, "legacy", "study"));

  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  expect(call).toHaveBeenCalledExactlyOnceWith("session.modelGet", {
    sessionId: "legacy",
  });
  expect(hook.result.current.settings).toEqual(legacy.settings);
});

it("loads the selected workspace model for a project draft", async () => {
  const call = vi.fn().mockResolvedValue(result("workspace-model"));
  const { client } = fakeClient(call);
  const hook = renderHook(() => useSessionModel(client, null, "study"));

  await waitFor(() => expect(hook.result.current.ready).toBe(true));

  expect(hook.result.current.effective?.model).toBe("workspace-model");
  expect(call).toHaveBeenCalledWith("workspace.modelGet", {
    workspaceId: "study",
  });
});

it("does not show the previous workspace model while switching projects", async () => {
  let resolveSecond!: (value: SessionModelResult) => void;
  const call = vi.fn((_method, params) =>
    params.workspaceId === "first"
      ? Promise.resolve(result("first-model"))
      : new Promise<SessionModelResult>((done) => {
          resolveSecond = done;
        })
  );
  const { client } = fakeClient(call);
  const hook = renderHook(
    ({ workspaceId }) => useSessionModel(client, null, workspaceId),
    { initialProps: { workspaceId: "first" } }
  );
  await waitFor(() => expect(hook.result.current.ready).toBe(true));

  hook.rerender({ workspaceId: "second" });

  expect(hook.result.current.ready).toBe(false);
  expect(hook.result.current.effective).toBeNull();
  await act(async () => resolveSecond(result("second-model")));
  expect(hook.result.current.effective?.model).toBe("second-model");
});

it("does not display an old session's update failure in the newly selected session", async () => {
  let reject!: (cause: Error) => void;
  const call = vi.fn((method, params) =>
    method === "model.update"
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

it("updates the global protocol even when the model is inherited", async () => {
  let apiProtocol = "responses";
  const call = vi.fn((method, params) => {
    if (method === "settings.get") return Promise.resolve({
      provider: { model: "global", apiProtocol, reasoningEffort: null },
    });
    if (params.settings.apiProtocol !== "auto") apiProtocol = params.settings.apiProtocol;
    return Promise.resolve({
      settings: params.settings,
      effective: { model: "global", apiProtocol, reasoningEffort: null },
    });
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
  expect(hook.result.current.effective?.apiProtocol).toBe("chat_completions");
  expect(call.mock.calls.map(([method]) => method)).toEqual([
    "settings.get", "model.update", "model.update",
  ]);
});

it("hides the previous model and error while the next session is loading", async () => {
  let resolveB!: (value: SessionModelResult) => void;
  const call = vi.fn((method, params) => {
    if (method === "model.update")
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

it("blocks another model update while one is pending", async () => {
  let complete!: (value: SessionModelResult) => void;
  const call = vi.fn((method, params) =>
    method === "model.update"
      ? new Promise<SessionModelResult>((resolve) => {
          complete = resolve;
        })
      : Promise.resolve(result(params.sessionId))
  );
  const { client } = fakeClient(call);
  const hook = renderHook(({ id }) => useSessionModel(client, id), {
    initialProps: { id: "a" },
  });
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  let updateA!: Promise<void>;
  act(() => {
    updateA = hook.result.current.update(DEFAULT_MODEL_SETTINGS);
  });
  hook.rerender({ id: "b" });
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  expect(hook.result.current.pending).toBe(true);
  await act(async () => hook.result.current.update(DEFAULT_MODEL_SETTINGS));
  expect(call.mock.calls.filter(([method]) => method === "model.update")).toHaveLength(1);
  await act(async () => {
    complete(result("updated-a"));
    await updateA;
  });
  expect(hook.result.current.pending).toBe(false);
});
