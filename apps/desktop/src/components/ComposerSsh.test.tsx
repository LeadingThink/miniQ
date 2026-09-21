// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerCard } from "./Composer";
import type { RpcClient } from "../rpc";

const fake = vi.hoisted(() => ({
  open: vi.fn(),
  invoke: vi.fn(),
  drop: null as null | ((event: unknown) => void),
}));
vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fake.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: fake.open }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    onDragDropEvent: async (callback: typeof fake.drop) => {
      fake.drop = callback;
      return () => {};
    },
  }),
}));
vi.mock("./VoiceInput", () => ({ VoiceInput: () => null }));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  fake.drop = null;
});

it("attaches an explicitly selected remote path and rejects a local drag without sending its path", async () => {
  const onSend = vi.fn(async () => true);
  const onError = vi.fn();
  const client = {
    mode: "remote",
    sshHost: "devbox",
    call: vi.fn().mockResolvedValue({ skills: [] }),
  } as unknown as RpcClient;
  render(
    <ComposerCard
      client={client}
      busy={false}
      draftKey="ssh:devbox:hero"
      placeholder="消息"
      onSend={onSend}
      onError={onError}
    />,
  );
  await waitFor(() => expect(fake.drop).not.toBeNull());
  fake.drop!({ payload: { type: "drop", paths: ["/Users/me/private.pdf"] } });
  expect(onError).toHaveBeenCalledWith(expect.stringContaining("先将文件传到该电脑"));
  expect(screen.queryByText("private.pdf")).toBeNull();
  fireEvent.click(screen.getByTitle("附加远程文件"));
  const dialog = screen.getByRole("dialog", { name: "附加远程文件" });
  fireEvent.change(within(dialog).getByRole("textbox"), {
    target: { value: "/home/me/report.pdf" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "确定" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), {
    target: { value: "检查这份资料" },
  });
  fireEvent.keyDown(screen.getByRole("textbox", { name: "消息" }), {
    key: "Enter",
  });
  await waitFor(() =>
    expect(onSend).toHaveBeenCalledWith("检查这份资料", [
      "/home/me/report.pdf",
    ]),
  );
  expect(fake.open).not.toHaveBeenCalled();
  expect(fake.invoke).not.toHaveBeenCalledWith(
    "read_image_preview",
    expect.anything(),
  );
});
