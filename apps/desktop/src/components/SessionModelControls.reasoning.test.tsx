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

it("shows the provider default inside the combined model panel", async () => {
  const model = setup(vi.fn().mockResolvedValue({ reasoningEfforts: [] }));
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  expect(await screen.findByRole("region", { name: "思考强度" })).toBeTruthy();
  expect(screen.getByText("当前模型使用默认思考强度")).toBeTruthy();
  expect(model.update).not.toHaveBeenCalled();
});

it("applies the selected model and advertised effort together", async () => {
  const call = vi.fn((method: string) => method === "model.list"
    ? Promise.resolve({ models: ["minimax-m3"] })
    : Promise.resolve({ reasoningEfforts: ["low", "high"] }));
  const model = setup(call);
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  fireEvent.click(await screen.findByRole("button", { name: "高" }));
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
  await waitFor(() => expect(model.update).toHaveBeenCalledExactlyOnceWith({
    ...DEFAULT_MODEL_SETTINGS,
    model: "minimax-m3",
    apiProtocol: "auto",
    reasoningEffort: "high",
  }));
});

it("distinguishes loading from unavailable reasoning settings", () => {
  setup(vi.fn().mockReturnValue(new Promise(() => {})));
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  expect(screen.getByText("正在读取当前模型的思考档位…")).toBeTruthy();
});
