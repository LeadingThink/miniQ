// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSessionModel } from "../hooks/useSessionModel";
import { DEFAULT_MODEL_SETTINGS, type SessionModelResult, type SessionModelSettings } from "../modelSelection";
import type { RpcClient } from "../rpc";
import type { DaemonEvent } from "../types";
import { SessionModelControls } from "./SessionModelControls";

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(save = vi.fn(async (_settings: SessionModelSettings) => {})) {
  let settings: SessionModelSettings = { ...DEFAULT_MODEL_SETTINGS, model: "claude-opus-4.8", reasoningEffort: "low" };
  const events = new Set<(event: DaemonEvent) => void>();
  const result = (): SessionModelResult => ({ settings, effective: { ...settings, model: settings.model! } });
  const call = vi.fn(async (method: string, params?: { settings: SessionModelSettings }) => {
    if (method === "session.modelGet") return result();
    if (method === "model.list") return { models: ["claude-opus-4.8", "gpt-5.6-sol"] };
    if (method === "model.describe") return { reasoningEfforts: ["low", "high"] };
    if (method === "session.modelUpdate") {
      await save(params!.settings);
      settings = params!.settings;
      events.forEach((listener) => listener({ type: "model_settings_changed", sessionId: "existing", workspaceId: "study", settings }));
      return result();
    }
    throw new Error(`Unexpected call: ${method}`);
  });
  const client = {
    call, connected: true, onStatus: () => () => {},
    onEvent: (listener: (event: DaemonEvent) => void) => {
      events.add(listener);
      return () => events.delete(listener);
    },
  } as unknown as RpcClient;
  function Picker() {
    const model = useSessionModel(client, "existing", "study");
    return <SessionModelControls client={client} model={model} busy={false} />;
  }
  render(<Picker />);
  return { call, save };
}

async function openPicker() {
  const trigger = screen.getByRole<HTMLButtonElement>("button", { name: "选择模型和思考强度" });
  await waitFor(() => expect(trigger.disabled).toBe(false));
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "选择会话模型" });
  await within(dialog).findByRole("option", { name: "claude-opus-4.8" });
  return dialog;
}

it.each(["claude-opus-4.8", "gpt-5.6-sol"])("saves %s and its effort together on an existing mobile session", async (model) => {
  const { call, save } = setup();
  const dialog = await openPicker();
  fireEvent.click(within(dialog).getByRole("option", { name: model }));
  fireEvent.click(await within(dialog).findByRole("button", { name: "高" }));
  fireEvent.click(within(dialog).getByRole("option", { name: model }));
  expect(within(dialog).getByRole("button", { name: "高" }).getAttribute("aria-pressed")).toBe("true");
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "完成" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_MODEL_SETTINGS, model, reasoningEffort: "high" });
  expect(call).toHaveBeenCalledWith("session.modelUpdate", { sessionId: "existing", settings: { ...DEFAULT_MODEL_SETTINGS, model, reasoningEffort: "high" } });
  const reopened = await openPicker();
  fireEvent.click(within(reopened).getByRole("option", { name: model }));
  expect((await within(reopened).findByRole("button", { name: "高" })).getAttribute("aria-pressed")).toBe("true");
});

it("discards unconfirmed changes and resets effort when choosing a different model", async () => {
  const { save } = setup();
  const dialog = await openPicker();
  fireEvent.click(within(dialog).getByRole("option", { name: "claude-opus-4.8" }));
  fireEvent.click(await within(dialog).findByRole("button", { name: "高" }));
  fireEvent.click(within(dialog).getByRole("option", { name: "gpt-5.6-sol" }));
  expect((await within(dialog).findByRole("button", { name: "默认" })).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭模型选择" }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "选择模型和思考强度" }).textContent).toContain("低");
  const reopened = await openPicker();
  expect(within(reopened).getByRole("option", { name: "claude-opus-4.8" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(within(reopened).getByRole("option", { name: "claude-opus-4.8" }));
  expect((await within(reopened).findByRole("button", { name: "低" })).getAttribute("aria-pressed")).toBe("true");
});

it("shows a failed save inside the modal and retains both selections for retry", async () => {
  let reject!: (error: Error) => void;
  const save = vi.fn<(settings: SessionModelSettings) => Promise<void>>()
    .mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }))
    .mockResolvedValue(undefined);
  setup(save);
  const dialog = await openPicker();
  fireEvent.click(within(dialog).getByRole("option", { name: "gpt-5.6-sol" }));
  fireEvent.click(await within(dialog).findByRole("button", { name: "高" }));
  const done = within(dialog).getByRole<HTMLButtonElement>("button", { name: "完成" });
  fireEvent.click(done);
  expect(done.disabled).toBe(true);
  await act(async () => reject(new Error("save failed")));
  expect(within(dialog).getByRole("alert").textContent).toContain("save failed");
  expect(within(dialog).getByRole("button", { name: "高" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(done);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(save).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenLastCalledWith({ ...DEFAULT_MODEL_SETTINGS, model: "gpt-5.6-sol", reasoningEffort: "high" });
});

it("can restore the current model's default effort and persist it", async () => {
  const { save } = setup();
  const dialog = await openPicker();
  fireEvent.click(within(dialog).getByRole("option", { name: "claude-opus-4.8" }));
  fireEvent.click(await within(dialog).findByRole("button", { name: "默认" }));
  expect(within(dialog).getByRole("button", { name: "默认" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(within(dialog).getByRole("button", { name: "完成" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(save).toHaveBeenCalledExactlyOnceWith({ ...DEFAULT_MODEL_SETTINGS, model: "claude-opus-4.8" });
  const reopened = await openPicker();
  fireEvent.click(within(reopened).getByRole("option", { name: "claude-opus-4.8" }));
  expect((await within(reopened).findByRole("button", { name: "默认" })).getAttribute("aria-pressed")).toBe("true");
});
