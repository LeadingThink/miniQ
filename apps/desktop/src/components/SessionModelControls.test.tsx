// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { useSessionModel } from "../hooks/useSessionModel";
import type { RpcClient } from "../rpc";
import { SessionModelControls } from "./SessionModelControls";

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

  const select = await screen.findByRole("button", { name: "模型 ID" });
  await waitFor(() => expect(select.textContent).toContain("gpt-5.6-sol"));
  fireEvent.click(select);

  const list = screen.getByRole("listbox", { name: "会话模型列表" });
  expect(list.className).toContain("session-model-list");
  expect(
    screen.getByRole("option", { name: "gpt-5.6-sol" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByRole("option", { name: "claude-sonnet" })).toBeTruthy();
  expect(screen.getByRole("option", { name: "deepseek-chat" })).toBeTruthy();

  fireEvent.click(screen.getByRole("option", { name: "claude-sonnet" }));
  expect(select.textContent).toContain("claude-sonnet");
});