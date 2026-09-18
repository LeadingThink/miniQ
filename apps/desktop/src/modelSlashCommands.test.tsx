// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSessionModel } from "./hooks/useSessionModel";
import { buildModelSlashCommands } from "./modelSlashCommands";
import {
  DEFAULT_MODEL_SETTINGS,
  type SessionModelResult,
} from "./modelSelection";
import type { RpcClient } from "./rpc";

afterEach(cleanup);

function fixture() {
  const call = vi
    .fn()
    .mockResolvedValue({ models: ["gpt-5.6-sol", "claude-sonnet"] });
  const client = { call } as unknown as RpcClient;
  const model = {
    settings: {
      model: "gpt-5.6-sol",
      apiProtocol: "responses",
      reasoningEffort: "high",
    },
    effective: {
      model: "gpt-5.6-sol",
      apiProtocol: "responses",
      reasoningEffort: "high",
    },
    ready: true,
    pending: false,
    update: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof useSessionModel>;
  return { call, client, model };
}

it("loads the text catalog only when opened and changes the session model with automatic protocol", async () => {
  const { call, client, model } = fixture();
  const [command] = buildModelSlashCommands(client, model, false);
  expect(call).not.toHaveBeenCalled();
  expect(command.insertText).toBeUndefined();
  const children = await command.loadChildren!();
  expect(call).toHaveBeenCalledExactlyOnceWith("model.list");
  expect(children.map(({ name, selected }) => ({ name, selected }))).toEqual([
    { name: "gpt-5.6-sol", selected: true },
    { name: "claude-sonnet", selected: false },
  ]);
  await children[1].onSelect!();
  expect(model.update).toHaveBeenCalledExactlyOnceWith({
    model: "claude-sonnet",
    apiProtocol: "auto",
    reasoningEffort: null,
  });
});

it("uses supported reasoning levels and preserves the current model when changing effort", async () => {
  const { call, client, model } = fixture();
  call.mockResolvedValue({
    model: "gpt-5.6-sol",
    reasoningEfforts: ["low", "high"],
  });
  const [, command] = buildModelSlashCommands(client, model, false);
  const children = await command.loadChildren!();
  expect(call).toHaveBeenCalledExactlyOnceWith("model.describe", {
    model: "gpt-5.6-sol",
    apiProtocol: "responses",
  });
  expect(children.map(({ id, selected }) => ({ id, selected }))).toEqual([
    { id: "reasoning:default", selected: false },
    { id: "reasoning:low", selected: false },
    { id: "reasoning:high", selected: true },
  ]);
  await children[1].onSelect!();
  expect(model.update).toHaveBeenCalledWith({
    model: "gpt-5.6-sol",
    apiProtocol: "auto",
    reasoningEffort: "low",
  });
  await children[0].onSelect!();
  expect(model.update).toHaveBeenLastCalledWith({
    model: "gpt-5.6-sol",
    apiProtocol: "auto",
    reasoningEffort: null,
  });
});

it("offers only the default when the model has no adjustable reasoning level", async () => {
  const { call, client, model } = fixture();
  call.mockResolvedValue({ model: "gemini-flash", reasoningEfforts: [] });
  model.settings.reasoningEffort = null;
  const [, command] = buildModelSlashCommands(client, model, false);
  const children = await command.loadChildren!();
  expect(children).toHaveLength(1);
  expect(children[0]).toMatchObject({
    id: "reasoning:default",
    selected: true,
  });
});

it.each(["busy", "pending", "not-ready"])(
  "disables both commands while %s",
  async (state) => {
    const { call, client, model } = fixture();
    model.pending = state === "pending";
    model.ready = state !== "not-ready";
    const commands = buildModelSlashCommands(client, model, state === "busy");
    for (const command of commands) {
      expect(command.disabled).toBe(true);
      expect(command.disabledReason).toBeTruthy();
      await expect(command.loadChildren!()).rejects.toThrow(
        command.disabledReason,
      );
    }
    expect(call).not.toHaveBeenCalled();
    expect(model.update).not.toHaveBeenCalled();
  },
);

it("propagates catalog, capability, and save errors so the menu can display and retry them", async () => {
  const { call, client, model } = fixture();
  const [catalog, reasoning] = buildModelSlashCommands(client, model, false);
  call.mockRejectedValueOnce(new Error("catalog unavailable"));
  await expect(catalog.loadChildren!()).rejects.toThrow("catalog unavailable");
  call.mockRejectedValueOnce(new Error("capabilities unavailable"));
  await expect(reasoning.loadChildren!()).rejects.toThrow(
    "capabilities unavailable",
  );
  const children = await catalog.loadChildren!();
  vi.mocked(model.update).mockRejectedValue(new Error("settings unavailable"));
  await expect(children[1].onSelect!()).rejects.toThrow("settings unavailable");
});

it("explains missing configuration without asking the server for an undefined model", async () => {
  const { call, client, model } = fixture();
  model.effective = null;
  const [, command] = buildModelSlashCommands(client, model, false);
  await expect(command.loadChildren!()).rejects.toThrow("API Key");
  expect(call).not.toHaveBeenCalled();
});

it("writes only the selected session through the real session-model hook", async () => {
  const initial: SessionModelResult = {
    settings: { ...DEFAULT_MODEL_SETTINGS, model: "gpt-5.6-sol" },
    effective: {
      model: "gpt-5.6-sol",
      apiProtocol: "responses",
      reasoningEffort: null,
    },
  };
  const call = vi.fn(
    async (
      method: string,
      params?: { settings?: SessionModelResult["settings"] },
    ) => {
      if (method === "session.modelGet") return initial;
      if (method === "model.list") return { models: ["claude-sonnet"] };
      if (method === "session.modelUpdate")
        return { ...initial, settings: params?.settings };
      throw new Error(`Unexpected RPC: ${method}`);
    },
  );
  const client = {
    call,
    connected: true,
    onStatus: () => () => {},
    onEvent: () => () => {},
  } as unknown as RpcClient;
  const hook = renderHook(() =>
    useSessionModel(client, "session-a", "shared-workspace"),
  );
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  const [command] = buildModelSlashCommands(client, hook.result.current, false);
  const children = await command.loadChildren!();
  await act(async () => {
    await children[0].onSelect!();
  });
  expect(call).toHaveBeenCalledWith("session.modelUpdate", {
    sessionId: "session-a",
    settings: {
      model: "claude-sonnet",
      apiProtocol: "auto",
      reasoningEffort: null,
    },
  });
  expect(call.mock.calls.map(([method]) => method)).toEqual([
    "session.modelGet",
    "model.list",
    "session.modelUpdate",
  ]);
});
