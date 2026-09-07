// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { ComputerSettings } from "./ComputerSettings";

afterEach(cleanup);
const permissions = {
  platform: "macos",
  processId: 42,
  executable: "/Applications/miniQ.app/Contents/MacOS/miniq-daemon",
  screenRecording: "denied",
  accessibility: "granted",
  displayServer: null,
};
const makeClient = (call: ReturnType<typeof vi.fn>, mode = "local") =>
  ({ call, mode, onStatus: () => () => {} }) as unknown as RpcClient;

it("checks without requesting access, and shows independent permission states", async () => {
  const call = vi.fn().mockResolvedValue(permissions);
  render(<ComputerSettings client={makeClient(call)} />);
  expect(await screen.findByText("未授权")).toBeTruthy();
  expect(screen.getByText("已授权")).toBeTruthy();
  expect(screen.getByText(permissions.executable)).toBeTruthy();
  expect(call.mock.calls.every(([method]) => method === "computer.permissions")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "打开屏幕录制系统设置" }));
  await waitFor(() =>
    expect(call).toHaveBeenCalledWith("computer.requestPermission", {
      permission: "screenRecording",
    }),
  );
});

it("remote diagnostics never offer system authorization controls", async () => {
  const call = vi.fn().mockResolvedValue(permissions);
  render(<ComputerSettings client={makeClient(call, "remote")} />);
  await screen.findByText("未授权");
  expect(screen.queryByRole("button", { name: /系统设置/ })).toBeNull();
  expect(call.mock.calls.every(([method]) => method === "computer.permissions")).toBe(true);
});

it("rechecks on focus, prevents overlapping requests, and recovers from errors", async () => {
  let resolve!: (value: unknown) => void;
  const call = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
  render(<ComputerSettings client={makeClient(call)} />);
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重新检查权限" }));
  fireEvent.focus(window);
  expect(call).toHaveBeenCalledTimes(2);
  await act(async () => resolve(permissions));
  expect(screen.queryByRole("alert")).toBeNull();
  call.mockResolvedValue({ ...permissions, screenRecording: "granted" });
  fireEvent.focus(window);
  await waitFor(() => expect(screen.getAllByText("已授权")).toHaveLength(2));
});

it("ignores old client results after switching connections", async () => {
  let resolve!: (value: unknown) => void;
  const old = makeClient(
    vi.fn().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    ),
  );
  const next = makeClient(vi.fn().mockResolvedValue({ ...permissions, executable: "new daemon" }));
  const view = render(<ComputerSettings client={old} />);
  view.rerender(<ComputerSettings client={next} />);
  await screen.findByText("new daemon");
  await act(async () => resolve(permissions));
  expect(screen.queryByText(permissions.executable)).toBeNull();
});
