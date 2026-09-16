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

it("reloads sessions on workspace model-change broadcasts", async () => {
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

  await waitFor(() => expect(hook.result.current.effective?.model).toBe("two"));
});

it("reloads sessions in any workspace on global model-change broadcasts", async () => {
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

  await waitFor(() =>
    expect(hook.result.current.effective?.model).toBe("global")
  );
});

it("keeps a project's draft selection local instead of updating other sessions", async () => {
  const call = vi.fn((method) =>
    Promise.resolve(
      method === "workspace.modelGet"
        ? result("workspace-model")
        : result("updated-model")
    )
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
  expect(call.mock.calls.map(([method]) => method)).toEqual(["workspace.modelGet"]);
  await act(async () => hook.result.current.reload());
  expect(hook.result.current.effective?.model).toBe("updated-model");
});

it("updates only the selected session model", async () => {
  const call = vi.fn().mockResolvedValue(result("updated-model"));
  const { client } = fakeClient(call);
  const hook = renderHook(() => useSessionModel(client, "session-a", "study"));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));

  await act(async () => hook.result.current.update(DEFAULT_MODEL_SETTINGS));

  expect(call).toHaveBeenLastCalledWith("session.modelUpdate", {
    sessionId: "session-a",
    settings: DEFAULT_MODEL_SETTINGS,
  });
});

it("migrates a legacy session protocol to automatic without changing its model or effort", async () => {
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
  const call = vi.fn((method, params) => {
    if (method === "session.modelGet") return Promise.resolve(legacy);
    if (method === "session.modelUpdate") {
      return Promise.resolve({
        settings: params.settings,
        effective: params.settings,
      });
    }
    throw new Error(`unexpected method ${method}`);
  });
  const { client } = fakeClient(call);
  const hook = renderHook(() => useSessionModel(client, "legacy", "study"));

  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  expect(call).toHaveBeenLastCalledWith("session.modelUpdate", {
    sessionId: "legacy",
    settings: {
      model: "claude-sonnet-4.6",
      apiProtocol: "auto",
      reasoningEffort: "high",
    },
  });
  expect(hook.result.current.settings).toEqual({
    model: "claude-sonnet-4.6",
    apiProtocol: "auto",
    reasoningEffort: "high",
  });
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
  const call = vi.fn((method, params) =>
    Promise.resolve(
      method === "settings.get"
        ? {
            provider: {
              model: "global",
              apiProtocol: "responses",
              reasoningEffort: null,
            },
          }
        : {
            settings: params.settings,
            effective: {
              model: "global",
              apiProtocol: params.settings.apiProtocol,
              reasoningEffort: null,
            },
          }
    )
  );
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
  expect(call.mock.calls.map(([method]) => method)).toEqual(["settings.get"]);
});

it("isolates draft choices by project and resets consumed drafts to the project defaults", async () => {
  const call = vi.fn((_method, params) => Promise.resolve(result(`${params.workspaceId}-default`)));
  const { client } = fakeClient(call);
  const hook = renderHook(({ workspaceId }) => useSessionModel(client, null, workspaceId), {
    initialProps: { workspaceId: "first" },
  });
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  const selection = { ...DEFAULT_MODEL_SETTINGS, model: "gpt", reasoningEffort: "high" as const };
  await act(async () => hook.result.current.update(selection));
  hook.rerender({ workspaceId: "second" });
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  expect(hook.result.current.effective?.model).toBe("second-default");
  await act(async () => hook.result.current.update({ ...DEFAULT_MODEL_SETTINGS, model: "claude" }));
  hook.rerender({ workspaceId: "first" });
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  expect(hook.result.current.settings).toEqual(selection);
  act(() => hook.result.current.clearDraft());
  await act(async () => hook.result.current.reload());
  expect(hook.result.current.effective?.model).toBe("first-default");
  expect(call.mock.calls.every(([method]) => method === "workspace.modelGet")).toBe(true);
});

it("does not clear a newer draft choice when an earlier task finishes starting", async () => {
  const { client } = fakeClient(vi.fn().mockResolvedValue(result("default")));
  const hook = renderHook(() => useSessionModel(client, null, "study"));
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  await act(async () => hook.result.current.update(result("first").settings));
  const clearEarlierDraft = hook.result.current.clearDraft;
  await act(async () => hook.result.current.update(result("second").settings));
  act(clearEarlierDraft);
  await act(async () => hook.result.current.reload());
  expect(hook.result.current.effective?.model).toBe("second");
});

it("does not leak a delayed session update into the new-conversation draft", async () => {
  let complete!: (value: SessionModelResult) => void;
  const call = vi.fn((method) => method === "session.modelUpdate"
    ? new Promise<SessionModelResult>((resolve) => { complete = resolve; })
    : Promise.resolve(result("project-default")));
  const { client } = fakeClient(call);
  const hook = renderHook(({ id }: { id: string | null }) => useSessionModel(client, id, "w"), {
    initialProps: { id: "a" as string | null },
  });
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  let updating!: Promise<void>;
  act(() => { updating = hook.result.current.update(result("updated-a").settings); });
  hook.rerender({ id: null });
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  await act(async () => { complete(result("updated-a")); await updating; });
  expect(hook.result.current.effective?.model).toBe("project-default");
  await act(async () => hook.result.current.reload());
  expect(hook.result.current.effective?.model).toBe("project-default");
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

it("blocks another session model update while one is pending", async () => {
  let complete!: (value: SessionModelResult) => void;
  const call = vi.fn((method, params) =>
    method === "session.modelUpdate"
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
  expect(call.mock.calls.filter(([method]) => method === "session.modelUpdate")).toHaveLength(1);
  await act(async () => {
    complete(result("updated-a"));
    await updateA;
  });
  expect(hook.result.current.pending).toBe(false);
});
