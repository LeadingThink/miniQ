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
    update: vi.fn().mockResolvedValue(undefined),
    reload: vi.fn(),
  } as unknown as ReturnType<typeof useSessionModel>;

  render(<SessionModelControls client={client} model={model} busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));

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
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  expect((screen.getByRole("textbox", { name: "模型 ID" }) as HTMLInputElement).value).toBe("");
  expect((screen.getByRole("textbox", { name: "模型 ID" }) as HTMLInputElement).placeholder).toBe("claude-sonnet");
  expect(screen.queryByText("API 协议")).toBeNull();
  expect(model.update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
  await waitFor(() => expect(model.update).toHaveBeenCalledExactlyOnceWith({
    model: "claude-sonnet", apiProtocol: "auto", reasoningEffort: null,
  }));
  await waitFor(() => expect(screen.queryByRole("form", { name: "会话模型配置" })).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  const reopened = await screen.findByRole("textbox", { name: "模型 ID" });
  fireEvent.focus(reopened);
  expect(screen.getAllByRole("option")).toHaveLength(3);
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
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  let input = await screen.findByRole("textbox", { name: "模型 ID" });
  await waitFor(() => expect(screen.getByRole("option", { name: "gpt-5.6-sol" })).toBeTruthy());
  input = screen.getByRole("textbox", { name: "模型 ID" });
  fireEvent.change(input, { target: { value: "claude" } });
  expect(screen.getByRole("option", { name: "claude-sonnet" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "gpt-5.6-sol" })).toBeNull();
  expect(screen.queryByRole("option", { name: "gpt-image-2" })).toBeNull();
  fireEvent.keyDown(input, { key: "Escape" });
  fireEvent.click(input);
  expect(screen.getAllByRole("option")).toHaveLength(3);
  expect((input as HTMLInputElement).value).toBe("");
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
  fireEvent.click(await screen.findByRole("option", { name: "claude-test" }));
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
  view.rerender(<SessionModelControls client={client} model={{ ...model, pending: true }} busy={false} />);
  expect(screen.getByRole("form", { name: "会话模型配置" })).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "正在应用…" }).disabled).toBe(true);
  reject(new Error("save failed"));
  view.rerender(<SessionModelControls client={client} model={{ ...model, error: "save failed" }} busy={false} />);
  expect(screen.getByRole("alert").textContent).toContain("save failed");
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
  await waitFor(() => expect(screen.queryByRole("form", { name: "会话模型配置" })).toBeNull());
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
  fireEvent.click(screen.getByRole("button", { name: "应用" }));
  await waitFor(() => expect(model.update).toHaveBeenCalledExactlyOnceWith({
    model: "gpt-5.6-sol", apiProtocol: "auto", reasoningEffort: null,
  }));
  await waitFor(() => expect(screen.queryByRole("form", { name: "会话模型配置" })).toBeNull());
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

it.each([[[]], [["other-model"]]])("does not apply an absent model when catalog is %j", async (models) => {
  const client = { call: vi.fn(async (method: string) => method === "model.list" ? { models } : { reasoningEfforts: [] }) } as unknown as RpcClient;
  const update = vi.fn();
  const model = { settings: { ...DEFAULT_MODEL_SETTINGS }, effective: { ...DEFAULT_MODEL_SETTINGS, model: "missing-model" }, ready: true, pending: false, error: null, update, reload: vi.fn() } as unknown as ReturnType<typeof useSessionModel>;
  render(<SessionModelControls client={client} model={model} busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "选择模型和思考强度" }));
  await waitFor(() => expect(screen.queryByText("正在读取模型列表")).toBeNull());
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "应用" }).disabled).toBe(true);
  fireEvent.submit(screen.getByRole("form", { name: "会话模型配置" }));
  expect(update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "恢复默认" }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ model: null, apiProtocol: "auto", reasoningEffort: null }));
});
