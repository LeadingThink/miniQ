// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { useSessionModel } from "../hooks/useSessionModel";
import type { RpcClient } from "../rpc";
import { SessionModelControls } from "./SessionModelControls";
import { DEFAULT_MODEL_SETTINGS } from "../modelSelection";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

it("opens the catalog at the current model and switches on click", async () => {
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
    update: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn(),
  } as unknown as ReturnType<typeof useSessionModel>;

  render(<SessionModelControls client={client} model={model} busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));

  const select = await screen.findByRole("textbox", { name: "模型 ID" });
  expect((select as HTMLInputElement).value).toBe("");

  const list = screen.getByRole("listbox", { name: "会话模型列表" });
  await waitFor(() => expect(screen.getByRole("option", { name: "gpt-5.6-sol" })).toBeTruthy());
  expect(list.className).toContain("model-picker-list");
  expect(
    screen.getByRole("option", { name: "gpt-5.6-sol" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.queryByRole("option", { name: "claude-sonnet" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Anthropic" }));
  expect(screen.getByRole("option", { name: "claude-sonnet" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "gpt-5.6-sol" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "DeepSeek" }));
  expect(screen.getByRole("option", { name: "deepseek-chat" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Anthropic" }));
  fireEvent.click(screen.getByRole("option", { name: "claude-sonnet" }));
  await waitFor(() => expect(model.update).toHaveBeenCalledExactlyOnceWith({
    model: "claude-sonnet", apiProtocol: "auto", reasoningEffort: null,
  }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
  expect(screen.getByRole("option", { name: "gpt-5.6-sol" })).toBeTruthy();
});

it("filters the model catalog as the user types and closes on Escape", async () => {
  const call = vi.fn((method: string) => method === "model.list"
    ? Promise.resolve({ models: ["gpt-5.6-sol", "claude-sonnet", "gpt-image-2"] })
    : Promise.resolve({ model: "gpt-5.6-sol", apiProtocol: "responses", reasoningEfforts: [] }));
  const client = { call } as unknown as RpcClient;
  const model = {
    settings: { ...DEFAULT_MODEL_SETTINGS }, effective: { model: "gpt-5.6-sol", apiProtocol: "responses", reasoningEffort: null },
    ready: true, pending: false, error: null, update: vi.fn(), reload: vi.fn(),
  } as unknown as ReturnType<typeof useSessionModel>;
  render(<SessionModelControls client={client} model={model} busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  let input = await screen.findByRole("textbox", { name: "模型 ID" });
  await waitFor(() => expect(screen.getByRole("option", { name: "gpt-5.6-sol" })).toBeTruthy());
  input = screen.getByRole("textbox", { name: "模型 ID" });
  fireEvent.change(input, { target: { value: "claude" } });
  expect(screen.getByRole("option", { name: "claude-sonnet" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "gpt-5.6-sol" })).toBeNull();
  expect(screen.queryByRole("option", { name: "gpt-image-2" })).toBeNull();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  expect(screen.getAllByRole("option")).toHaveLength(2);
  expect((screen.getByRole("textbox", { name: "模型 ID" }) as HTMLInputElement).value).toBe("");
});

it("groups desktop models by provider and keeps favorites available", async () => {
  const client = { call: vi.fn((method: string) => method === "model.list"
    ? Promise.resolve({ models: ["gpt-5.6-sol", "claude-sonnet", "deepseek-chat", "custom-model"] })
    : Promise.resolve({ reasoningEfforts: [] })) } as unknown as RpcClient;
  const model = {
    settings: { ...DEFAULT_MODEL_SETTINGS }, effective: { ...DEFAULT_MODEL_SETTINGS, model: "gpt-5.6-sol" },
    ready: true, pending: false, error: null, update: vi.fn(), reload: vi.fn(),
  } as unknown as ReturnType<typeof useSessionModel>;
  render(<SessionModelControls client={client} model={model} busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  await screen.findByRole("option", { name: "gpt-5.6-sol" });
  expect(screen.getByRole("button", { name: "收藏" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "OpenAI" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "Anthropic" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "DeepSeek" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "其他" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Anthropic" }));
  expect(screen.getByRole("option", { name: "claude-sonnet" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "gpt-5.6-sol" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "其他" }));
  expect(screen.getByRole("option", { name: "custom-model" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "OpenAI" }));
  const favoriteButton = screen.getByRole("button", { name: "收藏 gpt-5.6-sol" });
  expect(favoriteButton.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(favoriteButton);
  expect(screen.getByRole("button", { name: "取消收藏 gpt-5.6-sol" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "收藏" }));
  expect(screen.getByRole("option", { name: "gpt-5.6-sol" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "取消收藏 gpt-5.6-sol" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "旧模型" })).toBeNull();
  expect(screen.queryByRole("button", { name: "推荐模型" })).toBeNull();
});

it("shows availability statistics beside every desktop model", async () => {
  const client = { call: vi.fn((method: string) => {
    if (method === "model.list") return Promise.resolve({ models: ["gpt-5.6-sol", "gpt-6-luna"] });
    if (method === "model.performance") return Promise.resolve({
      windowHours: 72,
      models: {
        "gpt-5.6-sol": {
          availability: 99.94,
          throughput: 97.7,
          samples: 9511,
          series: [
            { ts: 1793095200, availability: 100, samples: 98 },
            { ts: 1793098800, availability: null, samples: 0 },
          ],
        },
      },
    });
    return Promise.resolve({ reasoningEfforts: [] });
  }) } as unknown as RpcClient;
  const model = {
    settings: { ...DEFAULT_MODEL_SETTINGS }, effective: { ...DEFAULT_MODEL_SETTINGS, model: "gpt-5.6-sol" },
    ready: true, pending: false, error: null, update: vi.fn(), reload: vi.fn(),
  } as unknown as ReturnType<typeof useSessionModel>;

  render(<SessionModelControls client={client} model={model} busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  await screen.findByRole("option", { name: "gpt-5.6-sol" });

  expect(screen.getByLabelText("gpt-5.6-sol 可用性 99.94%，吞吐 97.7 t/s，72 小时样本 9511")).toBeTruthy();
  expect(screen.getByLabelText("gpt-6-luna 暂无可用性统计")).toBeTruthy();
  expect(document.querySelectorAll(".model-performance-bar")).toHaveLength(2);
  expect(client.call).toHaveBeenCalledWith("model.performance");
});

it("keeps model selection available when performance statistics fail", async () => {
  const client = { call: vi.fn((method: string) => {
    if (method === "model.list") return Promise.resolve({ models: ["gpt-5.6-sol", "gpt-6-luna"] });
    if (method === "model.performance") return Promise.reject(new Error("offline"));
    return Promise.resolve({ reasoningEfforts: [] });
  }) } as unknown as RpcClient;
  const update = vi.fn().mockResolvedValue(undefined);
  const model = {
    settings: { ...DEFAULT_MODEL_SETTINGS }, effective: { ...DEFAULT_MODEL_SETTINGS, model: "gpt-5.6-sol" },
    ready: true, pending: false, error: null, update, reload: vi.fn(),
  } as unknown as ReturnType<typeof useSessionModel>;

  render(<SessionModelControls client={client} model={model} busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  const option = await screen.findByRole("option", { name: "gpt-6-luna" });
  expect(screen.getByLabelText("gpt-6-luna 暂无可用性统计")).toBeTruthy();
  fireEvent.click(option);
  await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-6-luna" })));
});

it("keeps the desktop panel during a pending save and supports retry after failure", async () => {
  const client = { call: vi.fn((method: string) => Promise.resolve(method === "model.list"
    ? { models: ["gpt-test", "claude-test"] } : { reasoningEfforts: [] })) } as unknown as RpcClient;
  let reject!: (error: Error) => void;
  const update = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = fail; }))
    .mockResolvedValue(undefined);
  const model = {
    settings: { ...DEFAULT_MODEL_SETTINGS }, effective: { ...DEFAULT_MODEL_SETTINGS, model: "gpt-test" },
    ready: true, pending: false, error: null, update, reload: vi.fn(),
  } as unknown as ReturnType<typeof useSessionModel>;
  const view = render(<SessionModelControls client={client} model={model} busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  await screen.findByRole("button", { name: "Anthropic" });
  fireEvent.click(screen.getByRole("button", { name: "Anthropic" }));
  fireEvent.click(await screen.findByRole("option", { name: "claude-test" }));
  view.rerender(<SessionModelControls client={client} model={{ ...model, pending: true }} busy={false} />);
  const panel = document.querySelector(".session-model-popover");
  expect(panel?.getAttribute("aria-busy")).toBe("true");
  reject(new Error("save failed"));
  view.rerender(<SessionModelControls client={client} model={{ ...model, error: "save failed" }} busy={false} />);
  expect(screen.getByRole("alert").textContent).toContain("save failed");
  fireEvent.click(screen.getByRole("option", { name: "claude-test" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(update).toHaveBeenCalledTimes(2);
});

it("never turns search text into a selectable model or submits it", async () => {
  const client = {
    call: vi.fn((method: string) => method === "model.list"
      ? Promise.resolve({ models: ["gpt-5.6-sol"] })
      : Promise.resolve({ model: "gpt-5.6-sol", apiProtocol: "responses", reasoningEfforts: [] })),
  } as unknown as RpcClient;
  const model = {
    settings: { ...DEFAULT_MODEL_SETTINGS },
    effective: { model: "gpt-5.6-sol", apiProtocol: "responses", reasoningEffort: null },
    ready: true, pending: false, error: null, update: vi.fn().mockResolvedValue(undefined), reload: vi.fn(),
  } as unknown as ReturnType<typeof useSessionModel>;
  render(<SessionModelControls client={client} model={model} busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  await screen.findByRole("option", { name: "gpt-5.6-sol" });
  const input = screen.getByRole("textbox", { name: "模型 ID" });
  fireEvent.change(input, { target: { value: "gp" } });
  expect(screen.queryByRole("option", { name: "gp" })).toBeNull();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(model.update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("option", { name: "gpt-5.6-sol" }));
  await waitFor(() => expect(model.update).toHaveBeenCalledExactlyOnceWith({
    model: "gpt-5.6-sol", apiProtocol: "auto", reasoningEffort: null,
  }));
  expect(screen.getByRole("button", { name: "选择模型和思考强度" }).getAttribute("aria-expanded")).toBe("false");
});

it("marks the hero model picker to open below its trigger", () => {
  const client = {
    call: vi.fn().mockResolvedValue({ model: "gpt-5.6-sol", apiProtocol: "responses", reasoningEfforts: [] }),
  } as unknown as RpcClient;
  const model = {
    settings: { ...DEFAULT_MODEL_SETTINGS },
    effective: { model: "gpt-5.6-sol", apiProtocol: "responses", reasoningEffort: null },
    ready: true,
    pending: false,
    error: null,
    update: vi.fn(),
    reload: vi.fn(),
  } as unknown as ReturnType<typeof useSessionModel>;

  render(<SessionModelControls client={client} model={model} busy={false} placement="below" />);

  expect(document.querySelector(".session-model-controls")?.classList.contains("popover-below")).toBe(true);
});

it.each([[[]], [["other-model"]]])("never applies a model the catalog does not list when it is %j", async (models) => {
  const client = { call: vi.fn(async (method: string) => method === "model.list" ? { models } : { reasoningEfforts: [] }) } as unknown as RpcClient;
  const update = vi.fn();
  const model = { settings: { ...DEFAULT_MODEL_SETTINGS }, effective: { ...DEFAULT_MODEL_SETTINGS, model: "missing-model" }, ready: true, pending: false, error: null, update, reload: vi.fn() } as unknown as ReturnType<typeof useSessionModel>;
  render(<SessionModelControls client={client} model={model} busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  await waitFor(() => expect(screen.queryByText("正在读取模型列表")).toBeNull());
  expect(screen.queryByRole("option", { name: "missing-model" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ model: "gpt-5.6-sol", apiProtocol: "auto", reasoningEffort: null }));
});
