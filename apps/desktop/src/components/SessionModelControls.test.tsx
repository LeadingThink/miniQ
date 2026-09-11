// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { useSessionModel } from "../hooks/useSessionModel";
import type { RpcClient } from "../rpc";
import { SessionModelControls } from "./SessionModelControls";
import { DEFAULT_MODEL_SETTINGS } from "../modelSelection";

afterEach(cleanup);

it("opens the bounded catalog at the current model and allows switching", async () => {
  const call = vi.fn((method: string) => {
    if (method === "model.list") {
      return Promise.resolve({
        models: ["gpt-5.6-sol", "claude-sonnet", "deepseek-chat"],
      });
    }
    return Promise.resolve({
      model: "gpt-5.6-sol",
      apiProtocol: "responses",
      reasoningEfforts: [],
      maxContextTokens: 1_000_000,
      maxOutputTokens: 128_000,
    });
  });
  const client = {
    call,
  } as unknown as RpcClient;
  const model = {
    settings: {
      model: null,
      apiProtocol: "auto" as const,
      reasoningEffort: null,
    },
    effective: {
      model: "gpt-5.6-sol",
      apiProtocol: "responses" as const,
      reasoningEffort: null,
    },
    ready: true,
    pending: false,
    error: null,
    update: vi.fn(),
    reload: vi.fn(),
  } as unknown as ReturnType<typeof useSessionModel>;

  render(<SessionModelControls client={client} model={model} busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "选择会话模型" }));

  const select = await screen.findByRole("textbox", { name: "模型 ID" });
  await waitFor(() => expect((select as HTMLInputElement).value).toBe(""));
  fireEvent.focus(select);

  const list = screen.getByRole("listbox", { name: "会话模型列表" });
  await waitFor(() => expect(screen.getByRole("option", { name: "claude-sonnet" })).toBeTruthy());
  expect(list.className).toContain("session-model-list");
  expect(
    screen.getByRole("option", { name: "gpt-5.6-sol" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByRole("option", { name: "claude-sonnet" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "deepseek-chat" })).toBeTruthy();

  fireEvent.click(screen.getByRole("option", { name: "claude-sonnet" }));
  expect((screen.getByRole("textbox", { name: "模型 ID" }) as HTMLInputElement).value).toBe("claude-sonnet");
});

it("filters the model catalog as the user types", async () => {
  const call = vi.fn((method: string) => method === "model.list"
    ? Promise.resolve({ models: ["gpt-5.6-sol", "claude-sonnet", "gpt-image-2"] })
    : Promise.resolve({ model: "gpt-5.6-sol", apiProtocol: "responses", reasoningEfforts: [] }));
  const client = { call } as unknown as RpcClient;
  const model = {
    settings: { ...DEFAULT_MODEL_SETTINGS }, effective: { model: "gpt-5.6-sol", apiProtocol: "responses", reasoningEffort: null },
    ready: true, pending: false, error: null, update: vi.fn(), reload: vi.fn(),
  } as unknown as ReturnType<typeof useSessionModel>;
  render(<SessionModelControls client={client} model={model} busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "选择会话模型" }));
  let input = await screen.findByRole("textbox", { name: "模型 ID" });
  await waitFor(() => expect(screen.getByRole("option", { name: "gpt-5.6-sol" })).toBeTruthy());
  input = screen.getByRole("textbox", { name: "模型 ID" });
  fireEvent.change(input, { target: { value: "claude" } });
  expect(screen.getByRole("option", { name: "claude-sonnet" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "gpt-5.6-sol" })).toBeNull();
  expect(screen.queryByRole("option", { name: "gpt-image-2" })).toBeNull();
});
