// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { PluginsPanel } from "./Plugins";
vi.mock("./ApprovalRules", () => ({ ApprovalRulesSection: () => null }));
afterEach(cleanup);
function client(call: ReturnType<typeof vi.fn>) {
  return { call, onEvent: () => () => {} } as unknown as RpcClient;
}
it("distinguishes loading, failed listing and confirmed empty, and retries", async () => {
  let reject!: (error: Error) => void;
  const call = vi.fn().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValue({ plugins: [] });
  render(<PluginsPanel client={client(call)} />);
  expect(screen.getByText("正在加载插件…")).toBeTruthy();
  expect(screen.queryByText("还没有插件")).toBeNull();
  await act(async () => reject(new Error("401 Unauthorized")));
  expect(screen.getByRole("alert").textContent).toContain("登录已过期");
  expect(screen.queryByText("还没有插件")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重新加载插件" }));
  expect(await screen.findByText("还没有插件")).toBeTruthy();
  expect(call).toHaveBeenCalledTimes(2);
});
it("ignores old-client list rejection after switching clients", async () => {
  let reject!: (error: Error) => void;
  const old = client(vi.fn(() => new Promise((_, fail) => { reject = fail; })));
  const next = client(vi.fn().mockResolvedValue({ plugins: [] }));
  const view = render(<PluginsPanel client={old} />);
  view.rerender(<PluginsPanel client={next} />);
  await screen.findByText("还没有插件");
  await act(async () => reject(new Error("stale failure")));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("还没有插件")).toBeTruthy();
});
