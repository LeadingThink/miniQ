// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RemoteBrowserPanel } from "./RemoteBrowserPanel";
import type { RpcClient } from "../rpc";
import type { ToolCall } from "../types";

afterEach(cleanup);
const record = (id: string, sessionId = "s1"): ToolCall => ({ id, sessionId,
  toolName: "browser_automation", input: { action: "snapshot" }, status: "succeeded",
  createdAt: `2026-09-19T01:0${id === "old" ? "1" : "2"}:00Z`, payloadDeferred: true,
});

it("loads only one selected observation, scopes to the current session, and cancels when closed", async () => {
  let finish!: (value: ToolCall) => void;
  const rpc = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const props = { client: { mode: "remote", call: rpc } as unknown as RpcClient,
    sessionId: "s1", calls: [record("old"), record("latest"), record("other", "s2")],
    hasOlder: true, loadingOlder: false, onLoadOlder: vi.fn(), onClose: vi.fn(), onDiscuss: vi.fn() };
  const view = render(<RemoteBrowserPanel {...props} />);
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc.mock.calls[0][1]).toEqual({ sessionId: "s1", toolCallId: "latest" });
  expect(screen.getAllByRole("option")).toHaveLength(2);
  await act(async () => finish({ ...record("latest"), payloadDeferred: false, output: { url: "https://example.test/form", title: "申请表" } }));
  fireEvent.click(screen.getByRole("button", { name: "继续操作这页" }));
  expect(props.onDiscuss.mock.calls[0][0]).toContain("https://example.test/form");
  expect(screen.getByText(/并非实时画面/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "加载更早记录" }));
  expect(props.onLoadOlder).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "old" } });
  await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
  const signal = rpc.mock.calls[1][2].signal as AbortSignal;
  view.unmount();
  expect(signal.aborted).toBe(true);
});

it("can retry a failed record without restarting the remote connection", async () => {
  const rpc = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ...record("latest"), payloadDeferred: false, output: { title: "已恢复" } });
  render(<RemoteBrowserPanel client={{ mode: "remote", call: rpc } as unknown as RpcClient} sessionId="s1" calls={[record("latest")]}
    hasOlder={false} loadingOlder={false} onLoadOlder={vi.fn()} onClose={vi.fn()} onDiscuss={vi.fn()} />);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "重新加载记录" }));
  await screen.findByText("已恢复");
  expect(rpc).toHaveBeenCalledTimes(2);
});
