// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { SessionPermissionControls } from "./SessionPermissionControls";

afterEach(cleanup);
const client = (call: ReturnType<typeof vi.fn>) =>
  ({
    call,
    onStatus: () => () => {},
    onEvent: () => () => {},
  }) as unknown as RpcClient;

it("changes only the selected session and can restore inheritance", async () => {
  const call = vi
    .fn()
    .mockResolvedValueOnce({ mode: null, effective: "auto" })
    .mockResolvedValueOnce({ mode: "alwaysAsk", effective: "alwaysAsk" })
    .mockResolvedValue({ mode: null, effective: "auto" });
  render(<SessionPermissionControls client={client(call)} sessionId="one" />);
  fireEvent.click(await screen.findByRole("button", { name: "替我审批" }));
  fireEvent.click(screen.getByRole("option", { name: /请求批准/ }));
  await screen.findByRole("button", { name: "请求批准" });
  expect(call.mock.calls[1].slice(0, 2)).toEqual([
    "session.approval.update",
    { sessionId: "one", mode: "alwaysAsk" },
  ]);
  fireEvent.click(screen.getByRole("button", { name: "恢复跟随全局审批设置" }));
  await screen.findByRole("button", { name: "替我审批" });
  expect(call.mock.lastCall?.[1]).toEqual({ sessionId: "one", mode: null });
});

it("does not apply stale permission data to another session", async () => {
  let finish!: (value: unknown) => void;
  const call = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ mode: "alwaysAsk", effective: "alwaysAsk" });
  const rpc = client(call);
  const view = render(
    <SessionPermissionControls client={rpc} sessionId="one" />,
  );
  view.rerender(<SessionPermissionControls client={rpc} sessionId="two" />);
  await screen.findByRole("button", { name: "请求批准" });
  await act(async () =>
    finish({ mode: "fullAccess", effective: "fullAccess" }),
  );
  expect(screen.queryByRole("button", { name: "完全访问" })).toBeNull();
});

it("can pin the currently inherited mode without changing it twice", async () => {
  const call = vi.fn().mockResolvedValueOnce({ mode: null, effective: "auto" }).mockResolvedValue({ mode: "auto", effective: "auto" });
  render(<SessionPermissionControls client={client(call)} sessionId="one" />);
  fireEvent.click(await screen.findByRole("button", { name: "替我审批" }));
  fireEvent.click(screen.getByRole("option", { name: /替我审批/ }));
  await screen.findByRole("button", { name: "恢复跟随全局审批设置" });
  expect(call.mock.calls[1].slice(0, 2)).toEqual(["session.approval.update", { sessionId: "one", mode: "auto" }]);
});

it("keeps the confirmed policy on a failed update and allows retry", async () => {
  const call = vi
    .fn()
    .mockResolvedValueOnce({ mode: null, effective: "auto" })
    .mockRejectedValueOnce(new Error("storage unavailable"))
    .mockResolvedValue({ mode: "alwaysAsk", effective: "alwaysAsk" });
  render(<SessionPermissionControls client={client(call)} sessionId="one" />);
  fireEvent.click(await screen.findByRole("button", { name: "替我审批" }));
  fireEvent.click(screen.getByRole("option", { name: /请求批准/ }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "替我审批" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "刷新会话权限" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});
