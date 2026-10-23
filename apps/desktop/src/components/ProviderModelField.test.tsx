// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { ProviderModelField } from "./ProviderModelField";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const baseProps = {
  baseUrl: "https://one.example/v1",
  ready: true,
  disabled: false,
  value: "saved-model",
  onChange: vi.fn(),
};
const options = () => Array.from(document.querySelectorAll("[role='option']"), (option) => option.textContent);
const openList = () => fireEvent.click(screen.getByRole("button", { name: "展开模型列表" }));
const load = () => act(() => vi.advanceTimersByTimeAsync(300));

it("reloads the draft endpoint and explicitly entered key without saving settings", async () => {
  const call = vi.fn().mockResolvedValue({ models: ["first"] });
  const client = { call } as unknown as RpcClient;
  const { rerender } = render(<ProviderModelField {...baseProps} client={client} />);
  await load();
  expect(call).toHaveBeenLastCalledWith("settings.models", { baseUrl: baseProps.baseUrl }, expect.anything());
  openList();
  expect(options()).toEqual(["first"]);

  call.mockResolvedValue({ models: ["second"] });
  rerender(<ProviderModelField {...baseProps} client={client} baseUrl="https://two.example/v1" apiKey="new-key" />);
  expect(options()).toEqual([]);
  await load();
  expect(call).toHaveBeenLastCalledWith("settings.models", { baseUrl: "https://two.example/v1", apiKey: "new-key" }, expect.anything());
  openList();
  expect(options()).toEqual(["second"]);
  expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("saved-model");
  expect(call.mock.calls.every(([method]) => method === "settings.models")).toBe(true);
});

it.each(["success", "failure"])("ignores stale catalog %s after the endpoint changes", async (outcome) => {
  let resolve!: (value: { models: string[] }) => void;
  let reject!: (reason: Error) => void;
  const oldRequest = new Promise<{ models: string[] }>((done, fail) => { resolve = done; reject = fail; });
  const call = vi.fn().mockReturnValueOnce(oldRequest).mockResolvedValue({ models: ["current"] });
  const client = { call } as unknown as RpcClient;
  const { rerender } = render(<ProviderModelField {...baseProps} client={client} />);
  await load();
  const signal = call.mock.calls[0][2].signal as AbortSignal;
  rerender(<ProviderModelField {...baseProps} client={client} baseUrl="https://two.example/v1" />);
  expect(signal.aborted).toBe(true);
  await load();
  await act(async () => {
    if (outcome === "success") resolve({ models: ["obsolete"] });
    else reject(new Error("obsolete error"));
  });
  openList();
  expect(options()).toEqual(["current"]);
  expect(screen.queryByText(/obsolete error/)).toBeNull();
});

it("can refresh after failure and still edit a model that is absent from the list", async () => {
  const onChange = vi.fn();
  const call = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue({ models: ["listed"] });
  render(<ProviderModelField {...baseProps} client={{ call } as unknown as RpcClient} onChange={onChange} />);
  await load();
  expect(screen.getByText(/模型列表读取失败：unavailable/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "刷新模型列表" }));
  await load();
  openList();
  expect(options()).toEqual(["listed"]);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "unlisted-model" } });
  expect(onChange).toHaveBeenCalledWith("unlisted-model");
});

it("shows the full catalog on open and filters only after typing", async () => {
  const onChange = vi.fn();
  const call = vi.fn().mockResolvedValue({ models: ["grok-4.7", "gpt-5.4", "claude-sonnet"] });
  render(<ProviderModelField {...baseProps} value="grok-4.7" client={{ call } as unknown as RpcClient} onChange={onChange} />);
  await load();
  openList();
  expect(options()).toEqual(["grok-4.7", "gpt-5.4", "claude-sonnet"]);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "gpt" } });
  expect(options()).toEqual(["gpt-5.4"]);
  fireEvent.click(screen.getByRole("option", { name: "gpt-5.4" }));
  expect(onChange).toHaveBeenLastCalledWith("gpt-5.4");
});

it("debounces typing and cancels requests when unmounted", async () => {
  const call = vi.fn().mockReturnValue(new Promise(() => {}));
  const client = { call } as unknown as RpcClient;
  const { rerender, unmount } = render(<ProviderModelField {...baseProps} client={client} />);
  rerender(<ProviderModelField {...baseProps} client={client} baseUrl="https://two.example/v1" />);
  await load();
  expect(call).toHaveBeenCalledTimes(1);
  const signal = call.mock.calls[0][2].signal as AbortSignal;
  unmount();
  expect(signal.aborted).toBe(true);
});

it("links to the model ranking and the availability catalog", () => {
  const call = vi.fn().mockResolvedValue({ models: [] });
  render(<ProviderModelField {...baseProps} client={{ call } as unknown as RpcClient} />);
  const ranking = screen.getByRole("link", { name: "查看模型热度榜" });
  const availability = screen.getByRole("link", { name: "查看模型可用性" });
  expect(ranking.getAttribute("href")).toBe("https://platform.zaiwenai.com/ranking");
  expect(availability.getAttribute("href")).toBe("https://platform.zaiwenai.com/models");
  expect(availability.getAttribute("title")).toBe("在问平台的模型列表与当前可用状态");
});
