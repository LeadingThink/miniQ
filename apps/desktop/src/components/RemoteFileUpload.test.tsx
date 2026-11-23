// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RemoteFileUpload } from "./RemoteFileUpload";
import { uploadRemoteFile } from "../remoteTransfer";
import type { FileReadOptions } from "../remoteFiles";
import { pickUploadSources, releaseUploadSources, stageBrowserUploadSources, usesNativeUploadPicker } from "../remoteUploadSource";
vi.mock("../remoteTransfer", () => ({ uploadRemoteFile: vi.fn() }));
vi.mock("../remoteUploadSource", () => ({
  usesNativeUploadPicker: vi.fn(() => false),
  pickUploadSources: vi.fn(),
  stageBrowserUploadSources: vi.fn(async (files) => files),
  releaseUploadSources: vi.fn(async () => {}),
}));
beforeEach(() => { vi.mocked(usesNativeUploadPicker).mockReturnValue(false); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const access = { client: { mode: "remote", call: vi.fn() }, sessionId: "s" } as FileReadOptions;
it("uploads the exact picker File and displays only the committed inbox receipt", async () => {
  let finish!: (value: Awaited<ReturnType<typeof uploadRemoteFile>>) => void;
  vi.mocked(uploadRemoteFile).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<RemoteFileUpload access={access} />);
  expect(screen.getByLabelText("选择本机文件").hasAttribute("accept")).toBe(false);
  expect(screen.getByText(/相册选择器可能转换格式/)).toBeTruthy();
  const file = new File(["heic-original"], "原图.heic", { type: "image/heic" });
  await act(async () => { fireEvent.change(screen.getByLabelText("选择照片和视频"), { target: { files: [file] } }); });
  expect(vi.mocked(uploadRemoteFile).mock.calls[0][2]).toBe(file);
  expect(screen.queryByText(/已收件/)).toBeNull();
  await act(async () => finish({ status: "completed", path: "/project/inbox/原图.heic", size: file.size, sha256: "a".repeat(64) }));
  expect(screen.getByText("已收件：/project/inbox/原图.heic")).toBeTruthy();
});
it("aborts an old session and suppresses its late receipt", async () => {
  let finish!: (value: Awaited<ReturnType<typeof uploadRemoteFile>>) => void;
  vi.mocked(uploadRemoteFile).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<RemoteFileUpload access={access} />);
  await act(async () => { fireEvent.change(screen.getByLabelText("选择本机文件"), { target: { files: [new File(["x"], "x")] } }); });
  const signal = vi.mocked(uploadRemoteFile).mock.calls[0][3]!;
  view.rerender(<RemoteFileUpload access={{ ...access, sessionId: "new" }} />);
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ status: "completed", path: "/old/x", size: 1, sha256: "a".repeat(64) }));
  expect(screen.queryByText(/已收件/)).toBeNull();
});
it("accepts mixed photos and videos and uploads their originals in selection order", async () => {
  vi.mocked(uploadRemoteFile).mockImplementation(async (_client, _scope, file) => ({
    status: "completed", path: `/project/inbox/${file.name}`, size: file.size, sha256: "a".repeat(64),
  }));
  render(<RemoteFileUpload access={access} />);
  const input = screen.getByLabelText("选择照片和视频") as HTMLInputElement;
  expect(input.accept.split(",")).toEqual(["image/*", "video/*", ".heic", ".heif"]);
  expect(input.multiple).toBe(true);
  const files = [new File(["image"], "照片.heic", { type: "image/heic" }), new File(["movie"], "视频.mov", { type: "video/quicktime" })];
  await act(async () => { fireEvent.change(input, { target: { files } }); });
  expect(vi.mocked(uploadRemoteFile).mock.calls.map(call => call[2])).toEqual(files);
  for (const file of files) expect(screen.getByText(`已收件：/project/inbox/${file.name}`)).toBeTruthy();
  expect(input.value).toBe("");
});
it("uses the native library for video originals and releases the cached selection after its receipt", async () => {
  vi.mocked(usesNativeUploadPicker).mockReturnValue(true);
  const video = { kind: "native" as const, id: "cached-mov", name: "视频.mov", size: 10, sha256: "b".repeat(64), release: vi.fn() };
  vi.mocked(pickUploadSources).mockResolvedValueOnce([video]);
  vi.mocked(uploadRemoteFile).mockResolvedValueOnce({ status: "completed", path: "/project/inbox/视频.mov", size: video.size, sha256: video.sha256 });
  render(<RemoteFileUpload access={access} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "上传照片和视频" })); });
  expect(pickUploadSources).toHaveBeenCalledExactlyOnceWith("photos", expect.any(AbortSignal));
  expect(vi.mocked(uploadRemoteFile).mock.calls[0][2]).toBe(video);
  expect(stageBrowserUploadSources).not.toHaveBeenCalled();
  expect(screen.getByText("已收件：/project/inbox/视频.mov")).toBeTruthy();
  expect(releaseUploadSources).toHaveBeenCalledExactlyOnceWith([video]);
});
it("uploads every saved WeChat file through the document picker and releases the selection", async () => {
  vi.mocked(usesNativeUploadPicker).mockReturnValue(true);
  const files = ["微信合同.docx", "微信表格.xlsx"].map((name, index) => ({ kind: "native" as const,
    id: `wechat-${index}`, name, size: 100, sha256: "b".repeat(64), release: vi.fn() }));
  vi.mocked(pickUploadSources).mockResolvedValueOnce(files);
  vi.mocked(uploadRemoteFile).mockImplementation(async (_client, _scope, file) => ({
    status: "completed", path: `/project/inbox/${file.name}`, size: file.size, sha256: "b".repeat(64),
  }));
  render(<RemoteFileUpload access={access} />);
  expect(screen.getByText(/先在微信中/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "上传微信文件" })); });
  expect(pickUploadSources).toHaveBeenCalledExactlyOnceWith("files", expect.any(AbortSignal));
  expect(vi.mocked(uploadRemoteFile).mock.calls.map(call => call[2])).toEqual(files);
  for (const file of files) expect(screen.getByText(`已收件：/project/inbox/${file.name}`)).toBeTruthy();
  expect(releaseUploadSources).toHaveBeenCalledWith(files);
});

it("opens the generic browser document input for WeChat exports", () => {
  render(<RemoteFileUpload access={access} />);
  const input = screen.getByLabelText<HTMLInputElement>("选择本机文件");
  const click = vi.spyOn(input, "click");
  fireEvent.click(screen.getByRole("button", { name: "上传微信文件" }));
  expect(click).toHaveBeenCalledOnce();
  expect(input.hasAttribute("accept")).toBe(false);
});
it("shows a failure without reporting a successful upload", async () => {
  vi.mocked(uploadRemoteFile).mockRejectedValue(new Error("桌面离线"));
  render(<RemoteFileUpload access={access} />);
  await act(async () => { fireEvent.change(screen.getByLabelText("选择本机文件"), { target: { files: [new File(["x"], "x")] } }); });
  await waitFor(() => expect(screen.getByText(/失败：桌面离线/)).toBeTruthy());
  expect(screen.queryByText(/已收件/)).toBeNull();
});
