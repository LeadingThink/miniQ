// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSessionModel } from "../hooks/useSessionModel";
import { DEFAULT_MODEL_SETTINGS, type SessionModelResult, type SessionModelSettings } from "../modelSelection";
import type { RpcClient } from "../rpc";
import { SessionModelControls } from "./SessionModelControls";

afterEach(cleanup);

const result = (settings: SessionModelSettings): SessionModelResult => ({
  settings,
  effective: { ...settings, model: settings.model ?? "gpt-5.6-sol" },
});

function setup(sessionId: string | null, save?: (settings: SessionModelSettings) => Promise<SessionModelResult>) {
  const call = vi.fn((method: string, params?: { settings: SessionModelSettings }) => {
    if (method === "workspace.modelGet" || method === "session.modelGet")
      return Promise.resolve(result(DEFAULT_MODEL_SETTINGS));
    if (method === "model.list") return Promise.resolve({ models: ["gpt-5.6-sol", "claude-test"] });
    if (method === "model.describe") return Promise.resolve({ reasoningEfforts: [] });
    if (method === "model.performance") return Promise.resolve({ windowHours: 72, models: {} });
    if (method === "model.update")
      return save ? save(params!.settings) : Promise.resolve(result(params!.settings));
    throw new Error(`Unexpected call: ${method}`);
  });
  const client = { call, connected: true, onStatus: () => () => {}, onEvent: () => () => {} } as unknown as RpcClient;
  function Picker() {
    const model = useSessionModel(client, sessionId, "stock_news");
    return <SessionModelControls client={client} model={model} busy={false} placement="below" />;
  }
  render(<Picker />);
  return { call };
}

async function openPicker() {
  const trigger = screen.getByRole<HTMLButtonElement>("button", { name: "选择模型和思考强度" });
  await waitFor(() => expect(trigger.disabled).toBe(false));
  fireEvent.click(trigger);
  await screen.findByRole("button", { name: "Anthropic" });
  return trigger;
}

it("applies the picked model globally from a new conversation", async () => {
  const { call } = setup(null);
  const trigger = await openPicker();
  expect(trigger.textContent).toContain("gpt-5.6-sol");
  expect(trigger.textContent).toContain("默认");
  fireEvent.click(screen.getByRole("button", { name: "Anthropic" }));
  fireEvent.click(screen.getByRole("option", { name: "claude-test" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(trigger.textContent).toContain("claude-test");
  expect(trigger.textContent).not.toContain("默认");
  expect(call).toHaveBeenCalledWith("model.update", {
    settings: { ...DEFAULT_MODEL_SETTINGS, model: "claude-test" },
  });
  await openPicker();
  expect(screen.getByRole("option", { name: "claude-test" }).getAttribute("aria-selected")).toBe("true");
});

it("waits for the save, shows failure, and closes only after a successful retry", async () => {
  let reject!: (error: Error) => void;
  const save = vi.fn<(settings: SessionModelSettings) => Promise<SessionModelResult>>()
    .mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }))
    .mockImplementation(async (settings) => result(settings));
  const { call } = setup("session-a", save);
  const trigger = await openPicker();
  fireEvent.click(screen.getByRole("option", { name: "gpt-5.6-sol" }));
  await waitFor(() => expect(document.querySelector(".session-model-popover")?.getAttribute("aria-busy")).toBe("true"));
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await act(async () => reject(new Error("save failed")));
  expect(screen.getByRole("alert").textContent).toContain("save failed");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("option", { name: "gpt-5.6-sol" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(save).toHaveBeenCalledTimes(2);
  expect(call).toHaveBeenLastCalledWith("model.update", {
    settings: { ...DEFAULT_MODEL_SETTINGS, model: "gpt-5.6-sol" },
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(trigger.textContent).toContain("gpt-5.6-sol");
  expect(trigger.textContent).toContain("默认");

  await openPicker();
  fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(save).toHaveBeenCalledTimes(3);
  expect(save).toHaveBeenLastCalledWith({
    ...DEFAULT_MODEL_SETTINGS,
    model: "gpt-5.6-sol",
  });
  expect(trigger.textContent).toContain("gpt-5.6-sol");
  expect(trigger.textContent).toContain("默认");
});
