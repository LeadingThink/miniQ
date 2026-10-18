// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerCard } from "./Composer";
import { uploadRemoteFile } from "../remoteTransfer";
import { readAttachments, storeAttachments } from "../composerDraft";
import type { RpcClient } from "../rpc";
vi.mock("../runtime", () => ({ isTauriRuntime: () => false }));
vi.mock("../remoteTransfer", () => ({ uploadRemoteFile: vi.fn() }));
vi.mock("./VoiceInput", () => ({ VoiceInput: () => null }));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });
const client = { mode: "remote", call: vi.fn().mockResolvedValue({ skills: [] }) } as unknown as RpcClient;
const base = { busy: false, placeholder: "消息", client, sessionId: "session-A", draftKey: "upload-A", onSend: vi.fn() };
const receipt = (path: string) => ({ status: "completed" as const, path, size: 1, sha256: "a".repeat(64) });
function open() {
  fireEvent.click(screen.getByRole("button", { name: "更多输入方式" }));
  fireEvent.click(screen.getByRole("button", { name: "附加远程文件" }));
}
function choose(name = "选择本机文件", count = 1) {
  const files = Array.from({ length: count }, (_, index) => new File(["x"], `${index}.heic`, { type: "image/heic" }));
  fireEvent.change(screen.getByLabelText(name), { target: { files } });
  return files;
}
it("offers original photos and files, waits for actual receipt, preserves text and never sends", async () => {
  let finish!: (result: ReturnType<typeof receipt>) => void;
  vi.mocked(uploadRemoteFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<ComposerCard {...base} />);
  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "我的草稿" } });
  open();
  expect(screen.getByRole("button", { name: "上传本机文件" })).toBeTruthy();
  const files = choose("选择照片原件");
  expect(vi.mocked(uploadRemoteFile).mock.calls[0].slice(0, 3)).toEqual([client, "session-A", files[0]]);
  expect(readAttachments("upload-A")).toEqual([]);
  act(() => vi.mocked(uploadRemoteFile).mock.calls[0][4]?.(1, 2));
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("50");
  expect((screen.getByRole("button", { name: "发送消息" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => finish(receipt("/project/inbox/actual.heic")));
  expect(readAttachments("upload-A")).toEqual(["/project/inbox/actual.heic"]);
  expect((screen.getByRole("textbox", { name: "消息" }) as HTMLTextAreaElement).value).toBe("我的草稿");
  expect(base.onSend).not.toHaveBeenCalled();
});
it.each(["session", "client", "unmount"])("keeps late committed receipt in original draft after %s change", async (change) => {
  let finish!: (result: ReturnType<typeof receipt>) => void;
  vi.mocked(uploadRemoteFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<ComposerCard {...base} />);
  open(); choose();
  const signal = vi.mocked(uploadRemoteFile).mock.calls[0][3]!;
  if (change === "unmount") view.unmount();
  else view.rerender(<ComposerCard {...base} draftKey="upload-B" sessionId={change === "session" ? "session-B" : base.sessionId} client={change === "client" ? { ...client } as RpcClient : client} />);
  expect(signal.aborted).toBe(true);
  await act(async () => finish(receipt("/old/late.heic")));
  expect(readAttachments("upload-A")).toEqual(["/old/late.heic"]);
  expect(readAttachments("upload-B")).toEqual([]);
  expect(screen.queryByText("late.heic")).toBeNull();
  expect(base.onSend).not.toHaveBeenCalled();
});
it("cancels current transfer and does not upload remaining selection", async () => {
  vi.mocked(uploadRemoteFile).mockImplementationOnce((_client, _session, _file, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")));
  }));
  render(<ComposerCard {...base} />);
  open(); choose("选择本机文件", 2);
  fireEvent.click(screen.getByRole("button", { name: "取消上传" }));
  await screen.findByText("已取消上传");
  expect(uploadRemoteFile).toHaveBeenCalledTimes(1);
  expect(readAttachments("upload-A")).toEqual([]);
});
it("rejects above ten including existing attachments without uploading a subset", () => {
  storeAttachments("upload-A", Array.from({ length: 9 }, (_, i) => `/existing/${i}.txt`));
  render(<ComposerCard {...base} />);
  open(); choose("选择本机文件", 2);
  expect(screen.getByRole("alert").textContent).toContain("最多附加 10");
  expect(uploadRemoteFile).not.toHaveBeenCalled();
  expect(readAttachments("upload-A")).toHaveLength(9);
});
it("attaches existing desktop paths without an upload or send", () => {
  render(<ComposerCard {...base} />);
  open();
  fireEvent.change(screen.getByLabelText("桌面已有文件路径"), { target: { value: "/project/existing.pdf" } });
  fireEvent.click(screen.getByRole("button", { name: "附加已有文件" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(readAttachments("upload-A")).toEqual(["/project/existing.pdf"]);
  expect(uploadRemoteFile).not.toHaveBeenCalled();
  expect(base.onSend).not.toHaveBeenCalled();
});
it("shows failure without attaching a guessed path", async () => {
  vi.mocked(uploadRemoteFile).mockRejectedValueOnce(new Error("桌面离线"));
  render(<ComposerCard {...base} />);
  open(); choose();
  await screen.findByText("桌面离线");
  expect(readAttachments("upload-A")).toEqual([]);
  expect(base.onSend).not.toHaveBeenCalled();
});
