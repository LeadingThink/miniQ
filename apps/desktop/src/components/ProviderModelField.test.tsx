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
import { ProviderModelField } from "./ProviderModelField";

afterEach(cleanup);

it.each(["baseUrl", "apiKey"] as const)(
  "cancels old %s requests and never lets a late catalog replace the new one",
  async (field) => {
    let finishOld!: (value: { models: string[] }) => void;
    let oldSignal!: AbortSignal;
    const call = vi
      .fn()
      .mockImplementationOnce((_method, _params, options) => {
        oldSignal = options.signal;
        return new Promise((resolve) => {
          finishOld = resolve;
        });
      })
      .mockResolvedValueOnce({ models: ["new-model"] });
    const props = {
      client: { call } as unknown as RpcClient,
      baseUrl: "https://one.test",
      apiKey: "",
      model: "custom",
      disabled: false,
      onChange: vi.fn(),
      onStatus: vi.fn(),
    };
    const view = render(<ProviderModelField {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
    view.rerender(
      <ProviderModelField
        {...props}
        {...{
          [field]: field === "baseUrl" ? "https://two.test" : "new-test-key",
        }}
      />,
    );
    expect(oldSignal.aborted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByRole("option", { name: "new-model" })).toBeTruthy();
    finishOld({ models: ["old-model"] });
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("option", { name: "old-model" })).toBeNull();
    expect(screen.getByRole("button", { name: "Model" }).textContent).toContain("custom");
    expect(props.onChange).not.toHaveBeenCalled();
  },
);

it("supports retry after failure and aborts an in-flight request on close", async () => {
  let signal!: AbortSignal;
  const call = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementationOnce((_method, _params, options) => {
      signal = options.signal;
      return new Promise(() => {});
    });
  const onStatus = vi.fn();
  const view = render(
    <ProviderModelField
      client={{ call } as unknown as RpcClient}
      baseUrl="https://one.test"
      apiKey=""
      model="custom"
      disabled={false}
      onChange={vi.fn()}
      onStatus={onStatus}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
  await waitFor(() =>
    expect(onStatus).toHaveBeenCalledWith("获取模型列表失败：offline"),
  );
  fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
  fireEvent.click(screen.getByRole("button", { name: "获取模型列表" }));
  expect(call).toHaveBeenCalledTimes(2);
  view.unmount();
  expect(signal.aborted).toBe(true);
});
