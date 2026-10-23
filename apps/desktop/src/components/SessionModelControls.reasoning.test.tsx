// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { useSessionModel } from "../hooks/useSessionModel";
import { DEFAULT_MODEL_SETTINGS } from "../modelSelection";
import { SessionModelControls } from "./SessionModelControls";

afterEach(cleanup);

function setup(call: ReturnType<typeof vi.fn>) {
  const client = { call } as unknown as RpcClient;
  const model = {
    settings: { ...DEFAULT_MODEL_SETTINGS },
    effective: {
      model: "minimax-m3",
      apiProtocol: "chat_completions",
      reasoningEffort: null,
    },
    ready: true,
    pending: false,
    error: null,
    update: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn(),
  } as unknown as ReturnType<typeof useSessionModel>;
  render(<SessionModelControls client={client} model={model} busy={false} />);
  return model;
}

it("states the provider default when a model exposes no reasoning levels", async () => {
  const model = setup(vi.fn((method: string) => Promise.resolve(method === "model.list"
    ? { models: ["minimax-m3"] }
    : { reasoningEfforts: [] })));
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  const row = await screen.findByRole("option", { name: "minimax-m3" });
  fireEvent.mouseEnter(row);
  expect(await screen.findByRole("group", { name: "思考强度" })).toBeTruthy();
  expect(screen.getByText("该模型不支持调整")).toBeTruthy();
  expect(model.update).not.toHaveBeenCalled();
});

it("opens the effort menu for the hovered model and applies both together", async () => {
  const call = vi.fn((method: string) => method === "model.list"
    ? Promise.resolve({ models: ["minimax-m3", "gpt-5.6-sol"] })
    : Promise.resolve({ reasoningEfforts: ["low", "high"] }));
  const model = setup(call);
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  const target = await screen.findByRole("option", { name: "gpt-5.6-sol" });
  expect(screen.queryByRole("button", { name: "高" })).toBeNull();
  fireEvent.mouseEnter(target);
  fireEvent.click(await screen.findByRole("button", { name: "高" }));
  await waitFor(() => expect(model.update).toHaveBeenCalledExactlyOnceWith({
    ...DEFAULT_MODEL_SETTINGS,
    model: "gpt-5.6-sol",
    apiProtocol: "auto",
    reasoningEffort: "high",
  }));
});

it("distinguishes loading from unavailable reasoning settings", async () => {
  setup(vi.fn((method: string) => method === "model.list"
    ? Promise.resolve({ models: ["minimax-m3"] })
    : new Promise(() => {})));
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  const row = await screen.findByRole("option", { name: "minimax-m3" });
  fireEvent.mouseEnter(row);
  expect(screen.getByText("读取档位…")).toBeTruthy();
});
