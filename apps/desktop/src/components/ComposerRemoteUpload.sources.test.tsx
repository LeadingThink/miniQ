// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerRemoteUpload } from "./ComposerRemoteUpload";
import { uploadRemoteFile } from "../remoteTransfer";
import { pickUploadSources, releaseUploadSources, stageBrowserUploadSources, usesNativeUploadPicker, type RemoteUploadSource } from "../remoteUploadSource";
import type { RpcClient } from "../rpc";

vi.mock("../remoteTransfer", () => ({ uploadRemoteFile: vi.fn() }));
vi.mock("../remoteUploadSource", () => ({
  usesNativeUploadPicker: vi.fn(() => true), pickUploadSources: vi.fn(),
  stageBrowserUploadSources: vi.fn(), releaseUploadSources: vi.fn(async () => {}),
}));
const cached = (id: string): RemoteUploadSource => ({ kind: "native", id, name: `${id}.heic`, size: 4, sha256: "a".repeat(64), release: vi.fn(async () => {}) });
const first = cached("first"); const second = cached("second");
const receipt = { status: "completed" as const, path: "/original/inbox/first.heic", size: 4, sha256: "a".repeat(64) };
const client = { call: vi.fn() } as unknown as RpcClient;
const props = { client, scope: { sessionId: "original" }, count: 0, onAttach: vi.fn(), run: vi.fn(async (operation: () => Promise<void>) => operation()), onClose: vi.fn() };
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  vi.mocked(usesNativeUploadPicker).mockReturnValue(true);
  vi.mocked(pickUploadSources).mockResolvedValue([first, second]);
  vi.mocked(uploadRemoteFile).mockResolvedValue(receipt);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("uses the native original picker and releases all cached selections after the queue finishes", async () => {
  render(<ComposerRemoteUpload {...props} count={8} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "上传照片原件" })); });
  expect(pickUploadSources).toHaveBeenCalledWith("photos", 2, expect.any(AbortSignal));
  expect(stageBrowserUploadSources).not.toHaveBeenCalled();
  expect(vi.mocked(uploadRemoteFile).mock.calls.map((args) => args.slice(0, 3))).toEqual([
    [client, { sessionId: "original" }, first], [client, { sessionId: "original" }, second],
  ]);
  expect(releaseUploadSources).toHaveBeenCalledWith([first, second]);
  expect(props.onAttach).toHaveBeenCalledTimes(2);
});

it("retains the browser input and stages the whole selection before the first network upload", async () => {
  vi.mocked(usesNativeUploadPicker).mockReturnValue(false);
  let staged!: (sources: RemoteUploadSource[]) => void;
  vi.mocked(stageBrowserUploadSources).mockImplementationOnce(() => new Promise((resolve) => { staged = resolve; }));
  render(<ComposerRemoteUpload {...props} />);
  const input = screen.getByLabelText("选择本机文件") as HTMLInputElement;
  let selectionValue = "C:\\fakepath\\first.heic";
  Object.defineProperty(input, "value", { configurable: true, get: () => selectionValue, set: (value) => { selectionValue = value; } });
  const originals = [new File(["x"], "first.heic"), new File(["y"], "second.heic")];
  fireEvent.change(input, { target: { files: originals } });
  expect(props.run).toHaveBeenCalledOnce();
  expect(stageBrowserUploadSources).toHaveBeenCalledWith(originals, expect.any(AbortSignal));
  expect(uploadRemoteFile).not.toHaveBeenCalled();
  expect(selectionValue).toContain("fakepath");
  await act(async () => { staged([first, second]); });
  expect(uploadRemoteFile).toHaveBeenCalledTimes(2);
  expect(selectionValue).toBe("");
});

it("cancels a pending picker on unmount and releases late sources without uploading to another draft", async () => {
  let finish!: (sources: RemoteUploadSource[]) => void;
  vi.mocked(pickUploadSources).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<ComposerRemoteUpload {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "上传本机文件" }));
  const signal = vi.mocked(pickUploadSources).mock.calls[0][2]!;
  view.unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => { finish([first, second]); });
  expect(uploadRemoteFile).not.toHaveBeenCalled();
  expect(props.onAttach).not.toHaveBeenCalled();
  expect(releaseUploadSources).toHaveBeenCalledWith([first, second]);
});

it("releases both current and queued caches when upload fails", async () => {
  vi.mocked(uploadRemoteFile).mockRejectedValueOnce(new Error("桌面离线"));
  render(<ComposerRemoteUpload {...props} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "上传本机文件" })); });
  expect(screen.getByRole("alert").textContent).toBe("桌面离线");
  expect(uploadRemoteFile).toHaveBeenCalledTimes(1);
  expect(releaseUploadSources).toHaveBeenCalledWith([first, second]);
});
