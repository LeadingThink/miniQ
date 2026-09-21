// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionModelControls } from "./SessionModelControls";
import type { RpcClient } from "../rpc";
import type { useSessionModel } from "../hooks/useSessionModel";
import { DEFAULT_MODEL_SETTINGS } from "../modelSelection";

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup() {
  const client = { call: vi.fn((method) => Promise.resolve(method === "model.list"
    ? { models: ["gpt-5.6-sol", "claude-opus-very-long-model-name"] }
    : { reasoningEfforts: ["low", "high"] })) } as unknown as RpcClient;
  const model = { settings: { ...DEFAULT_MODEL_SETTINGS }, effective: { ...DEFAULT_MODEL_SETTINGS, model: "gpt-5.6-sol" },
    ready: true, pending: false, error: null, update: vi.fn().mockResolvedValue(undefined), reload: vi.fn(),
  } as unknown as ReturnType<typeof useSessionModel>;
  const view = render(<SessionModelControls client={client} model={model} busy={false} />);
  return { ...view, client, model };
}

it("uses a modal top layer on the phone, shows full options without opening the keyboard, and applies once", async () => {
  const { model } = setup();
  const trigger = screen.getByRole("button", { name: "选择会话模型" });
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "选择会话模型" });
  expect((dialog as HTMLDialogElement).open).toBe(true);
  expect(document.activeElement).toBe(dialog);
  const option = await within(dialog).findByRole("option", { name: "claude-opus-very-long-model-name" });
  fireEvent.mouseDown(option);
  fireEvent.click(option);
  expect(screen.getByRole("dialog")).toBe(dialog);
  expect((within(dialog).getByRole("textbox", { name: "模型 ID" }) as HTMLInputElement).value).toBe("claude-opus-very-long-model-name");
  fireEvent.click(within(dialog).getByRole("button", { name: "应用" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(model.update).toHaveBeenCalledExactlyOnceWith({ model: "claude-opus-very-long-model-name", apiProtocol: "auto", reasoningEffort: null });
  expect(document.activeElement).toBe(trigger);
});

it("filters while typing without closing the portal, and dismisses safely on task start", async () => {
  const view = setup();
  fireEvent.click(screen.getByRole("button", { name: "选择会话模型" }));
  await screen.findByRole("option", { name: "gpt-5.6-sol" });
  const input = screen.getByRole("textbox", { name: "模型 ID" });
  fireEvent.mouseDown(input);
  fireEvent.change(input, { target: { value: "opus" } });
  expect(fireEvent.keyDown(input, { key: "Enter" })).toBe(false);
  expect(view.model.update).not.toHaveBeenCalled();
  expect(screen.queryByRole("option", { name: "gpt-5.6-sol" })).toBeNull();
  expect(screen.getByRole("option", { name: "claude-opus-very-long-model-name" })).toBeTruthy();
  view.rerender(<SessionModelControls client={view.client} model={view.model} busy />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(view.model.update).not.toHaveBeenCalled();
});

it("handles Escape inside the native dialog before its default cancel closes the surface", async () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: "选择会话模型" }));
  await screen.findByRole("option", { name: "gpt-5.6-sol" });
  const input = screen.getByRole("textbox", { name: "模型 ID" });
  expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(false);
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(false);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it.each([
  { width: 768, height: 1024, touch: true, dialog: true },
  { width: 1024, height: 1366, touch: true, dialog: true },
  { width: 1440, height: 900, touch: false, dialog: false },
])("chooses the appropriate model surface for $width px with touch=$touch", async ({ width, height, touch, dialog }) => {
  vi.stubGlobal("innerWidth", width);
  vi.stubGlobal("innerHeight", height);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.split(",").some((clause) => {
      const maxWidth = clause.match(/max-width:\s*(\d+)px/);
      const maxHeight = clause.match(/max-height:\s*(\d+)px/);
      return (!maxWidth || width <= Number(maxWidth[1]))
        && (!maxHeight || height <= Number(maxHeight[1]))
        && (!clause.includes("pointer: coarse") || touch);
    }),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }));
  setup();
  fireEvent.click(screen.getByRole("button", { name: "选择会话模型" }));
  await screen.findByRole("textbox", { name: "模型 ID" });
  expect(screen.queryByRole("dialog", { name: "选择会话模型" }) !== null).toBe(dialog);
  expect(screen.getByRole("form", { name: "会话模型配置" }).closest(".session-model-controls") !== null).toBe(!dialog);
});
