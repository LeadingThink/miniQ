// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  expect(vi.mocked(uploadRemoteFile).mock.calls[0].slice(0, 3)).toEqual([client, { sessionId: "session-A" }, files[0]]);
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
it("lists every selected file with its own state and marks untouched files as not uploaded after a failure", async () => {
  vi.mocked(uploadRemoteFile).mockRejectedValueOnce(new Error("桌面离线"));
  render(<ComposerCard {...base} />);
  open(); choose("选择本机文件", 3);
  await screen.findByText("桌面离线");
  const rows = screen.getByRole("list", { name: "上传队列" }).querySelectorAll("li");
  expect([...rows].map((row) => row.getAttribute("data-state"))).toEqual(["failed", "skipped", "skipped"]);
  expect(screen.getByText(/失败 · /)).toBeTruthy();
  expect(screen.getAllByText(/未上传 · /)).toHaveLength(2);
  expect(screen.getAllByRole("button", { name: "关闭" })).toHaveLength(2);
});

const projectBase = { ...base, sessionId: undefined, workspaceId: "project-A", draftKey: "hero-A" };
it("uploads by workspace before a session exists and attaches the receipt to the hero draft without sending", async () => {
  vi.mocked(uploadRemoteFile).mockResolvedValueOnce(receipt("/project/inbox/u/photo.heic"));
  render(<ComposerCard {...projectBase} />);
  open();
  expect(screen.getByRole("button", { name: "上传照片原件" })).toBeTruthy();
  const files = choose("选择照片原件");
  expect(vi.mocked(uploadRemoteFile).mock.calls[0].slice(0, 3)).toEqual([client, { workspaceId: "project-A" }, files[0]]);
  await waitFor(() => expect(readAttachments("hero-A")).toEqual(["/project/inbox/u/photo.heic"]));
  expect(base.onSend).not.toHaveBeenCalled();
});
it.each(["workspace", "client", "unmount"])("keeps a late workspace receipt in the initiating hero draft after %s change", async (change) => {
  let finish!: (result: ReturnType<typeof receipt>) => void;
  vi.mocked(uploadRemoteFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<ComposerCard {...projectBase} />);
  open(); choose();
  const signal = vi.mocked(uploadRemoteFile).mock.calls[0][3]!;
  if (change === "unmount") view.unmount();
  else view.rerender(<ComposerCard {...projectBase} draftKey="hero-B" workspaceId={change === "workspace" ? "project-B" : "project-A"} client={change === "client" ? { ...client } as RpcClient : client} />);
  expect(signal.aborted).toBe(true);
  await act(async () => finish(receipt("/old/late.heic")));
  expect(readAttachments("hero-A")).toEqual(["/old/late.heic"]);
  expect(readAttachments("hero-B")).toEqual([]);
  expect(base.onSend).not.toHaveBeenCalled();
});
it("enforces the ten attachment limit for the workspace scope", () => {
  storeAttachments("hero-A", Array.from({ length: 9 }, (_, i) => `/existing/${i}.txt`));
  render(<ComposerCard {...projectBase} />);
  open(); choose("选择本机文件", 2);
  expect(screen.getByRole("alert").textContent).toContain("最多附加 10");
  expect(uploadRemoteFile).not.toHaveBeenCalled();
});
it("closes the upload sheet when the project changes", () => {
  const view = render(<ComposerCard {...projectBase} />);
  open();
  expect(screen.getByRole("dialog", { name: "附加远程文件" })).toBeTruthy();
  view.rerender(<ComposerCard {...projectBase} workspaceId="project-B" />);
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("falls back to the path dialog and explains that a project is required when neither id exists", () => {
  render(<ComposerCard {...projectBase} workspaceId={undefined} />);
  open();
  const dialog = screen.getByRole("dialog", { name: "附加远程文件" });
  expect(within(dialog).getByRole("note").textContent).toContain("请先选择一个项目");
  expect(within(dialog).queryByRole("button", { name: "上传照片原件" })).toBeNull();
  expect(uploadRemoteFile).not.toHaveBeenCalled();
});
