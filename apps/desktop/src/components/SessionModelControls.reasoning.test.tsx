// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

it("explains provider-default reasoning instead of showing an inert disabled button", async () => {
  const model = setup(vi.fn().mockResolvedValue({ reasoningEfforts: [] }));
  const trigger = await screen.findByRole<HTMLButtonElement>("button", {
    name: "默认推理",
  });
  expect(trigger.disabled).toBe(false);
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "推理设置说明" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain(
    "当前模型未提供可选的推理强度",
  );
  expect(model.update).not.toHaveBeenCalled();
});

it("makes a failed capability request retryable and saves only an advertised effort", async () => {
  const call = vi
    .fn()
    .mockRejectedValueOnce(new Error("request failed"))
    .mockResolvedValue({ reasoningEfforts: ["low", "high"] });
  const model = setup(call);
  fireEvent.click(await screen.findByRole("button", { name: "读取失败" }));
  fireEvent.click(screen.getByRole("button", { name: "重新读取推理选项" }));
  await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
  fireEvent.click(await screen.findByRole("button", { name: "默认推理" }));
  expect(screen.queryByRole("dialog", { name: "推理设置说明" })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: "高" }));
  expect(model.update).toHaveBeenCalledExactlyOnceWith({
    ...DEFAULT_MODEL_SETTINGS,
    reasoningEffort: "high",
  });
});

it("distinguishes loading from unavailable reasoning settings", () => {
  setup(vi.fn().mockReturnValue(new Promise(() => {})));
  fireEvent.click(screen.getByRole("button", { name: "读取中" }));
  expect(screen.getByRole("status").textContent).toBe(
    "正在读取当前模型的推理选项…",
  );
  expect(screen.queryByText(/未提供可选/)).toBeNull();
});
