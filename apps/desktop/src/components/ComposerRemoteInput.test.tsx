// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerCard } from "./Composer";
import type { RpcClient } from "../rpc";
import { uploadRemoteFile } from "../remoteTransfer";
import { stageDesktopUploadSources } from "../desktopUploadSource";
import { releaseUploadSources, stageBrowserUploadSources } from "../remoteUploadSource";
import { readAttachments, readDraft, storeAttachments } from "../composerDraft";

const native = vi.hoisted(() => ({ drop: null as null | ((event: unknown) => void) }));
vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ onDragDropEvent: async (callback: typeof native.drop) => { native.drop = callback; return () => {}; } }),
}));
vi.mock("../remoteTransfer", () => ({ uploadRemoteFile: vi.fn() }));
vi.mock("../desktopUploadSource", () => ({ stageDesktopUploadSources: vi.fn() }));
vi.mock("../remoteUploadSource", () => ({
  usesNativeUploadPicker: () => false,
  stageBrowserUploadSources: vi.fn(async files => files),
  releaseUploadSources: vi.fn(async () => {}),
}));
vi.mock("./VoiceInput", () => ({ VoiceInput: () => null }));
beforeEach(() => {
  client = { mode: "remote", sshHost: "devbox", call: vi.fn().mockResolvedValue({ skills: [] }) } as unknown as RpcClient;
  props.client = client;
  vi.mocked(uploadRemoteFile).mockReset();
  vi.mocked(stageDesktopUploadSources).mockReset();
  props.onSend.mockReset();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });

let client = { mode: "remote", sshHost: "devbox", call: vi.fn().mockResolvedValue({ skills: [] }) } as unknown as RpcClient;
const props = { client, sessionId: "session-A", draftKey: "draft-A", busy: false, placeholder: "消息", onSend: vi.fn(), onError: vi.fn() };
const receipt = (path: string) => ({ status: "completed" as const, path, size: 1, sha256: "a".repeat(64) });
const source = { kind: "browser" as const, name: "原件.pdf", size: 1, sha256: "a".repeat(64), file: new File(["x"], "原件.pdf"), release: vi.fn() };
async function drop(paths = ["C:\\private\\原件.pdf"]) {
  await waitFor(() => expect(native.drop).not.toBeNull());
  await act(async () => native.drop!({ payload: { type: "drop", paths } }));
}
async function paste(target: HTMLElement = screen.getByRole("textbox", { name: "消息" }), files = [new File(["image"], "截图.png", { type: "image/png" })]) {
  await act(async () => { expect(fireEvent.paste(target, { clipboardData: { items: [], files } })).toBe(false); });
  return files;
}

it("uploads a desktop drop, shows progress and sends only the confirmed remote receipt", async () => {
  vi.mocked(stageDesktopUploadSources).mockResolvedValueOnce([source]);
  let finish!: (value: ReturnType<typeof receipt>) => void;
  vi.mocked(uploadRemoteFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<ComposerCard {...props} />);
  const input = screen.getByRole("textbox", { name: "消息" });
  fireEvent.change(input, { target: { value: "检查原件" } });
  await drop();
  expect(stageDesktopUploadSources).toHaveBeenCalledWith(["C:\\private\\原件.pdf"], expect.any(AbortSignal));
  expect(vi.mocked(uploadRemoteFile).mock.calls[0].slice(0, 3)).toEqual([client, { sessionId: "session-A" }, source]);
  expect(readAttachments("draft-A")).toEqual([]);
  act(() => vi.mocked(uploadRemoteFile).mock.calls[0][4]?.(1, 2));
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("50");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "发送消息" }).disabled).toBe(false);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(props.onSend).not.toHaveBeenCalled();
  await act(async () => finish(receipt("/project/inbox/原件.pdf")));
  expect(props.onSend).toHaveBeenCalledExactlyOnceWith("检查原件", ["/project/inbox/原件.pdf"]);
  expect(readAttachments("draft-A")).toEqual([]);
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" }).value).toBe("");
  expect(props.onError).not.toHaveBeenCalled();
});

it.each(["input", "transcript"])("uploads a clipboard image from %s once even under StrictMode", async (target) => {
  vi.mocked(uploadRemoteFile).mockResolvedValueOnce(receipt("/project/inbox/截图.png"));
  render(<StrictMode><ComposerCard {...props} /></StrictMode>);
  const files = await paste(target === "transcript" ? document.body : undefined);
  expect(stageBrowserUploadSources).toHaveBeenCalledExactlyOnceWith(files, expect.any(AbortSignal));
  expect(uploadRemoteFile).toHaveBeenCalledOnce();
  expect(stageDesktopUploadSources).not.toHaveBeenCalled();
  expect(readAttachments("draft-A")).toEqual(["/project/inbox/截图.png"]);
  expect(props.onSend).not.toHaveBeenCalled();
});

it("uploads to the selected project before a session exists", async () => {
  vi.mocked(uploadRemoteFile).mockResolvedValueOnce(receipt("/project/inbox/截图.png"));
  render(<ComposerCard {...props} sessionId={undefined} workspaceId="project-A" />);
  await paste();
  expect(vi.mocked(uploadRemoteFile).mock.calls[0][1]).toEqual({ workspaceId: "project-A" });
});

it.each(["paste", "drop"])("requires a project before staging a %s", async (method) => {
  render(<ComposerCard {...props} sessionId={undefined} />);
  if (method === "drop") await drop(); else await paste();
  expect(props.onError).toHaveBeenCalledWith(expect.stringContaining("请先选择远程项目"));
  expect(stageBrowserUploadSources).not.toHaveBeenCalled();
  expect(stageDesktopUploadSources).not.toHaveBeenCalled();
  expect(readAttachments("draft-A")).toEqual([]);
});

it("accepts another file during an upload and keeps the composer editable", async () => {
  let finish!: (value: ReturnType<typeof receipt>) => void;
  vi.mocked(uploadRemoteFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  vi.mocked(stageDesktopUploadSources).mockResolvedValueOnce([source]);
  vi.mocked(uploadRemoteFile).mockResolvedValueOnce(receipt("/project/inbox/原件.pdf"));
  render(<ComposerCard {...props} />);
  await paste();
  await drop();
  expect(props.onError).not.toHaveBeenCalled();
  expect(stageDesktopUploadSources).toHaveBeenCalledOnce();
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" });
  expect(input.readOnly).toBe(false);
  fireEvent.change(input, { target: { value: "继续写消息" } });
  await act(async () => finish(receipt("/project/inbox/截图.png")));
  expect(readAttachments("draft-A")).toEqual(["/project/inbox/原件.pdf", "/project/inbox/截图.png"]);
  expect(input.value).toBe("继续写消息");
});

it.each(["session", "client", "unmount"])("cancels a pending upload on %s change and keeps a late receipt in its original draft", async (change) => {
  let finish!: (value: ReturnType<typeof receipt>) => void;
  vi.mocked(uploadRemoteFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<ComposerCard {...props} />);
  await paste();
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  const signal = vi.mocked(uploadRemoteFile).mock.calls[0][3]!;
  if (change === "unmount") view.unmount();
  else view.rerender(<ComposerCard {...props} draftKey="draft-B" sessionId={change === "session" ? "session-B" : props.sessionId} client={change === "client" ? { ...client } as RpcClient : client} />);
  expect(signal.aborted).toBe(true);
  await act(async () => finish(receipt("/project/inbox/late.png")));
  expect(readAttachments("draft-A")).toEqual(["/project/inbox/late.png"]);
  expect(readAttachments("draft-B")).toEqual([]);
  expect(screen.queryByText("late.png")).toBeNull();
  expect(props.onSend).not.toHaveBeenCalled();
});

it("shows a read error and preserves the draft without attaching a local path", async () => {
  vi.mocked(stageDesktopUploadSources).mockRejectedValueOnce(new Error("无法打开本机文件"));
  render(<ComposerCard {...props} />);
  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "保留草稿" } });
  await drop();
  expect(screen.getByRole("alert").textContent).toBe("无法打开本机文件");
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" }).value).toBe("保留草稿");
  expect(readAttachments("draft-A")).toEqual([]);
  expect(uploadRemoteFile).not.toHaveBeenCalled();
  expect(releaseUploadSources).toHaveBeenCalled();
});

it.each(["paste", "drop"])("attaches an over-ten %s without dropping files", async (method) => {
  let uploaded = 0;
  vi.mocked(uploadRemoteFile).mockImplementation(async () => receipt(`/project/inbox/${uploaded++}.pdf`));
  vi.mocked(stageDesktopUploadSources).mockImplementation(async paths => paths.map(path => ({ ...source, name: path.split("\\").pop()! })));
  storeAttachments("draft-A", Array.from({ length: 9 }, (_, index) => `/existing/${index}.pdf`));
  render(<ComposerCard {...props} />);
  if (method === "drop") await drop(["C:\\one.pdf", "C:\\two.pdf"]);
  else await paste(undefined, [new File(["1"], "one.pdf"), new File(["2"], "two.pdf")]);
  await waitFor(() => expect(readAttachments("draft-A")).toHaveLength(11));
  expect(props.onError).not.toHaveBeenCalled();
});

it("waits through preparation and upload, then sends an attachment-only message once", async () => {
  let staged!: (sources: typeof source[]) => void;
  vi.mocked(stageDesktopUploadSources).mockImplementationOnce(() => new Promise(resolve => { staged = resolve; }));
  vi.mocked(uploadRemoteFile).mockResolvedValueOnce(receipt("/project/inbox/原件.pdf"));
  render(<ComposerCard {...props} />);
  await drop();
  expect(screen.getByText("准备中")).toBeTruthy();
  const send = screen.getByRole("button", { name: "发送消息" });
  fireEvent.click(send);
  fireEvent.click(send);
  expect(props.onSend).not.toHaveBeenCalled();
  expect(screen.getByText("正在等待附件，完成后自动发送")).toBeTruthy();
  await act(async () => staged([source]));
  expect(props.onSend).toHaveBeenCalledExactlyOnceWith("", ["/project/inbox/原件.pdf"]);
  expect(screen.queryByRole("list", { name: "待上传附件" })).toBeNull();
});

it("cancels waiting without cancelling the upload and keeps subsequent edits", async () => {
  let finish!: (value: ReturnType<typeof receipt>) => void;
  vi.mocked(uploadRemoteFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<ComposerCard {...props} />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" });
  fireEvent.change(input, { target: { value: "原消息" } });
  await paste();
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  expect(input.readOnly).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "取消等待发送" }));
  expect(input.readOnly).toBe(false);
  fireEvent.change(input, { target: { value: "修改后的消息" } });
  expect(vi.mocked(uploadRemoteFile).mock.calls[0][3]?.aborted).toBe(false);
  await act(async () => finish(receipt("/project/inbox/截图.png")));
  expect(props.onSend).not.toHaveBeenCalled();
  expect(readDraft("draft-A")).toBe("修改后的消息");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(props.onSend).toHaveBeenCalledExactlyOnceWith("修改后的消息", ["/project/inbox/截图.png"]);
});

it("stops automatic sending immediately when a pending attachment is removed", async () => {
  let finish!: (value: ReturnType<typeof receipt>) => void;
  vi.mocked(uploadRemoteFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<ComposerCard {...props} />);
  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "保留文字" } });
  await paste();
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "移除待上传附件 截图.png" })));
  expect(screen.queryByText("正在等待附件，完成后自动发送")).toBeNull();
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" }).readOnly).toBe(false);
  await act(async () => finish(receipt("/project/inbox/removed.png")));
  expect(props.onSend).not.toHaveBeenCalled();
  expect(readAttachments("draft-A")).toEqual([]);
  expect(readDraft("draft-A")).toBe("保留文字");
});

it("restores editing on failure and can retry the preserved original after remount", async () => {
  let fail!: (error: Error) => void;
  vi.mocked(uploadRemoteFile).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const view = render(<ComposerCard {...props} />);
  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "保留文字" } });
  await paste();
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await act(async () => fail(new Error("远程电脑离线")));
  expect(screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" }).readOnly).toBe(false);
  expect(readDraft("draft-A")).toBe("保留文字");
  expect(props.onSend).not.toHaveBeenCalled();
  view.unmount();
  render(<ComposerCard {...props} />);
  expect(screen.getByRole("alert").textContent).toBe("远程电脑离线");
  let finish!: (value: ReturnType<typeof receipt>) => void;
  vi.mocked(uploadRemoteFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "重试上传 截图.png" }));
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await act(async () => finish(receipt("/project/inbox/retried.png")));
  expect(stageBrowserUploadSources).toHaveBeenCalledOnce();
  expect(props.onSend).toHaveBeenCalledExactlyOnceWith("保留文字", ["/project/inbox/retried.png"]);
});

it("keeps confirmed attachments and text when the send is rejected", async () => {
  props.onSend.mockResolvedValueOnce(false);
  vi.mocked(uploadRemoteFile).mockResolvedValueOnce(receipt("/project/inbox/截图.png"));
  render(<ComposerCard {...props} />);
  fireEvent.change(screen.getByRole("textbox", { name: "消息" }), { target: { value: "保留文字" } });
  await paste();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(readDraft("draft-A")).toBe("保留文字");
  expect(readAttachments("draft-A")).toEqual(["/project/inbox/截图.png"]);
});

it("rechecks send permission after uploads finish", async () => {
  let finish!: (value: ReturnType<typeof receipt>) => void;
  vi.mocked(uploadRemoteFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<ComposerCard {...props} />);
  await paste();
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  view.rerender(<ComposerCard {...props} sendBlocked />);
  await act(async () => finish(receipt("/project/inbox/截图.png")));
  expect(props.onSend).not.toHaveBeenCalled();
  expect(readAttachments("draft-A")).toEqual(["/project/inbox/截图.png"]);
});

it("cancels a waiting send when a transcript paste edits its text", async () => {
  let finish!: (value: ReturnType<typeof receipt>) => void;
  vi.mocked(uploadRemoteFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  render(<ComposerCard {...props} />);
  await paste();
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  fireEvent.paste(document.body, { clipboardData: { items: [], files: [], getData: () => "补充说明" } });
  await act(async () => finish(receipt("/project/inbox/截图.png")));
  expect(props.onSend).not.toHaveBeenCalled();
  expect(readDraft("draft-A")).toBe("补充说明");
  expect(readAttachments("draft-A")).toEqual(["/project/inbox/截图.png"]);
});
