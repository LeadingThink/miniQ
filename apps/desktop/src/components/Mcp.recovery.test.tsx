// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { McpPanel } from "./Mcp";
import { ToastProvider } from "./ui/Toast";

afterEach(cleanup);
const rpc = (call: ReturnType<typeof vi.fn>) => ({ call, onStatus: () => () => {} }) as unknown as RpcClient;
const server = (name: string, enabled = true) => ({ name, command: "node", args: [], enabled, status: "configured" });
const deferred = <T,>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };

it("shows loading and recoverable load error, then empty only after success", async () => {
  const pending = deferred<unknown>();
  const call = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ servers: [] });
  render(<McpPanel client={rpc(call)} />);
  expect(screen.getByRole("status").textContent).toContain("加载");
  await act(async () => pending.reject(new Error("offline")));
  expect((await screen.findByRole("alert")).textContent).toContain("offline");
  expect(screen.queryByText("还没有 MCP 服务器")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByText("还没有 MCP 服务器");
});

it("captures add rejection, preserves input, and prevents duplicate submits", async () => {
  const denied = deferred<unknown>();
  const call = vi.fn().mockResolvedValueOnce({ servers: [] }).mockReturnValueOnce(denied.promise);
  render(<McpPanel client={rpc(call)} />);
  await screen.findByText("还没有 MCP 服务器");
  fireEvent.change(screen.getByPlaceholderText("my-server"), { target: { value: "demo" } });
  fireEvent.change(screen.getByPlaceholderText("npx / python / 可执行文件路径"), { target: { value: "node" } });
  const add = screen.getByRole("button", { name: "添加" });
  fireEvent.click(add); fireEvent.click(add);
  await act(async () => denied.reject(new Error("denied")));
  await screen.findByRole("alert");
  expect(call).toHaveBeenCalledTimes(2);
  expect(screen.getByDisplayValue("demo")).toBeTruthy();
});

it("ignores old client responses after switching client", async () => {
  const old = deferred<unknown>();
  const oldCall = vi.fn().mockReturnValue(old.promise);
  const newCall = vi.fn().mockResolvedValue({ servers: [server("new")] });
  const view = render(<McpPanel client={rpc(oldCall)} />);
  view.rerender(<McpPanel client={rpc(newCall)} />);
  await screen.findByText("new");
  await act(async () => old.resolve({ servers: [server("old")] }));
  await waitFor(() => expect(screen.queryByText("old")).toBeNull());
});

it("resets saving when switching client during a save", async () => {
  const update = deferred<unknown>();
  const oldCall = vi.fn()
    .mockResolvedValueOnce({ servers: [server("old")] })
    .mockReturnValueOnce(update.promise);
  const newCall = vi.fn().mockResolvedValue({ servers: [server("new")] });
  const view = render(<McpPanel client={rpc(oldCall)} />);
  await screen.findByText("old");
  fireEvent.click(screen.getByRole("switch", { name: "停用old" }));
  expect(screen.getByText("正在保存...")).toBeTruthy();

  view.rerender(<McpPanel client={rpc(newCall)} />);
  await screen.findByText("new");
  expect(screen.queryByText("正在保存...")).toBeNull();
  await act(async () => update.resolve({}));
  expect(newCall).not.toHaveBeenCalledWith("mcp.update", expect.anything());
});

it("does not commit a pending removal after switching client", async () => {
  const oldCall = vi.fn().mockResolvedValue({ servers: [server("old")] });
  const newCall = vi.fn().mockResolvedValue({ servers: [server("new")] });
  const view = render(
    <ToastProvider>
      <McpPanel client={rpc(oldCall)} />
    </ToastProvider>,
  );
  await screen.findByText("old");
  fireEvent.click(screen.getByRole("button", { name: "移除" }));
  view.rerender(
    <ToastProvider>
      <McpPanel client={rpc(newCall)} />
    </ToastProvider>,
  );
  await screen.findByText("new");
  fireEvent.click(screen.getByRole("button", { name: "关闭通知" }));
  await act(async () => undefined);
  expect(oldCall).not.toHaveBeenCalledWith("mcp.update", expect.anything());
  expect(newCall).not.toHaveBeenCalledWith("mcp.update", expect.anything());
});

it("does not commit a pending removal after the panel unmounts", async () => {
  const oldCall = vi.fn().mockResolvedValue({ servers: [server("old")] });
  const view = render(
    <ToastProvider>
      <McpPanel client={rpc(oldCall)} />
    </ToastProvider>,
  );
  await screen.findByText("old");
  fireEvent.click(screen.getByRole("button", { name: "移除" }));
  view.rerender(<ToastProvider>{null}</ToastProvider>);
  fireEvent.click(screen.getByRole("button", { name: "关闭通知" }));
  await act(async () => undefined);
  expect(oldCall).not.toHaveBeenCalledWith("mcp.update", expect.anything());
});
