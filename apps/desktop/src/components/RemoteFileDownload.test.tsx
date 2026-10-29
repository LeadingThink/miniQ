// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { RemoteFileDownload } from "./RemoteFileDownload";
import { downloadRemoteFile } from "../remoteTransfer";
import { saveRemoteFile } from "../nativeFileTransfer";
const state = vi.hoisted(() => ({ native: false, access: { client: { mode: "remote", call: vi.fn() }, sessionId: "one" } }));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => state.native } }));
vi.mock("../nativeFileTransfer", () => ({ saveRemoteFile: vi.fn() }));
vi.mock("../sessionFileAccess", () => ({ useSessionFileAccess: () => state.access }));
vi.mock("../remoteTransfer", async (original) => ({ ...await original<object>(), downloadRemoteFile: vi.fn() }));
const ticket = { transferId: "t", getUrl: "https://s3.qiniucs.com/bucket/remote-files/r/x", expiresAt: Date.now() + 600000, size: 3, sha256: "a".repeat(64), revision: "v1" };
beforeEach(() => {
    vi.clearAllMocks();
    state.native = false;
    state.access = { client: { mode: "remote", call: vi.fn(async (method) => method === "file.describe" ? {
        path: "/work/result.pdf", kind: "pdf", mimeType: "application/pdf", revision: "v1", size: 3, chunkBytes: 262144,
    } : ticket) }, sessionId: "one" };
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:file"), revokeObjectURL: vi.fn() }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => { });
    Object.defineProperty(navigator, "canShare", { configurable: true, value: vi.fn(() => true) });
    Object.defineProperty(navigator, "share", { configurable: true, value: vi.fn().mockResolvedValue(undefined) });
    vi.mocked(downloadRemoteFile).mockResolvedValue({ ...ticket, blob: new Blob(["pdf"]) });
    vi.mocked(saveRemoteFile).mockResolvedValue({ status: "shared" });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });
const start = () => { const view = render(<RemoteFileDownload path="/work/result.pdf" onError={vi.fn()}/>); fireEvent.click(screen.getByRole("button", { name: "下载到当前设备" })); return view; };
it("keeps a browser save link and shares verified bytes without another transfer", async () => {
    start();
    const link = await screen.findByRole("link");
    expect(link.getAttribute("download")).toBe("result.pdf");
    fireEvent.click(screen.getByRole("button", { name: "分享或存储文件" }));
    expect(navigator.share).toHaveBeenCalledWith({ files: [expect.objectContaining({ name: "result.pdf" })] });
    expect(downloadRemoteFile).toHaveBeenCalledTimes(1);
});
it("streams native downloads directly to disk without reading WebView bytes", async () => {
    state.native = true;
    start();
    await waitFor(() => expect(saveRemoteFile).toHaveBeenCalled());
    expect(downloadRemoteFile).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(saveRemoteFile).toHaveBeenCalledWith(expect.objectContaining({ url: ticket.getUrl, size: 3, sha256: ticket.sha256 }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
});
it("aborts the old session and ignores a late Blob", async () => {
    let finish!: (value: Awaited<ReturnType<typeof downloadRemoteFile>>) => void;
    vi.mocked(downloadRemoteFile).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = start();
    await waitFor(() => expect(downloadRemoteFile).toHaveBeenCalled());
    const signal = vi.mocked(downloadRemoteFile).mock.calls[0][4]!;
    state.access = { ...state.access, sessionId: "two" };
    view.rerender(<RemoteFileDownload path="/work/result.pdf" onError={vi.fn()}/>);
    expect(signal.aborted).toBe(true);
    await act(async () => finish({ ...ticket, blob: new Blob(["pdf"]) }));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it("releases browser URLs after the save grace period", async () => {
    const view = start();
    await screen.findByRole("link");
    vi.useFakeTimers();
    view.unmount();
    vi.advanceTimersByTime(60000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:file");
});
it("does not treat a dismissed share sheet as failure", async () => {
    vi.mocked(navigator.share).mockRejectedValue(new DOMException("cancelled", "AbortError"));
    const error = vi.fn();
    render(<RemoteFileDownload path="x" onError={error}/>);
    fireEvent.click(screen.getByRole("button", { name: "下载到当前设备" }));
    fireEvent.click(await screen.findByRole("button", { name: "分享或存储文件" }));
    await waitFor(() => expect(navigator.share).toHaveBeenCalled());
    expect(error).not.toHaveBeenCalled();
});
it("downloads SSH bytes through the prepared RPC stream from the preview button", async () => {
    Object.assign(state.access.client, { sshHost: "server" });
    const original = state.access.client.call.getMockImplementation()!;
    state.access.client.call.mockImplementation(async (method, params) => {
        if (method === "file.download.prepare") return { ...ticket, getUrl: undefined, transport: "connection", chunkBytes: 262144,
            sha256: createHash("sha256").update("pdf").digest("hex") };
        if (method === "file.download.read") return { offset: 0, nextOffset: 3, totalBytes: 3, revision: "v1", done: true, dataBase64: "cGRm" };
        if (method === "file.transfer.cancel") return { status: "cancelled" };
        return original(method, params);
    });
    start();
    expect((await screen.findByRole("link")).getAttribute("download")).toBe("result.pdf");
    expect(downloadRemoteFile).not.toHaveBeenCalled();
    expect(state.access.client.call).toHaveBeenCalledWith("file.download.read", expect.objectContaining({ sessionId: "one", transferId: "t" }), expect.anything());
});
it("explains the native SSH save limitation without opening a storage download", async () => {
    state.native = true;
    Object.assign(state.access.client, { sshHost: "server" });
    const onError = vi.fn();
    render(<RemoteFileDownload path="/work/result.pdf" onError={onError}/>);
    fireEvent.click(screen.getByRole("button", { name: "下载到当前设备" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("手机端暂不支持保存 SSH 文件")));
    expect(state.access.client.call).not.toHaveBeenCalled();
    expect(saveRemoteFile).not.toHaveBeenCalled();
});
