// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RemoteFileUpload } from "./RemoteFileUpload";
import { uploadRemoteFile } from "../remoteTransfer";
import type { FileReadOptions } from "../remoteFiles";
vi.mock("../remoteTransfer", () => ({ uploadRemoteFile: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const access = { client: { mode: "remote", call: vi.fn() }, sessionId: "s" } as FileReadOptions;
it("uploads the exact picker File and displays only the committed inbox receipt", async () => {
  let finish!: (value: Awaited<ReturnType<typeof uploadRemoteFile>>) => void;
  vi.mocked(uploadRemoteFile).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  render(<RemoteFileUpload access={access} />);
  expect(screen.getByLabelText("选择本机文件").hasAttribute("accept")).toBe(false);
  expect(screen.getByText(/照片选择器可能转换格式/)).toBeTruthy();
  const file = new File(["heic-original"], "原图.heic", { type: "image/heic" });
  fireEvent.change(screen.getByLabelText("选择照片"), { target: { files: [file] } });
  expect(vi.mocked(uploadRemoteFile).mock.calls[0][2]).toBe(file);
  expect(screen.queryByText(/已收件/)).toBeNull();
  await act(async () => finish({ status: "completed", path: "/project/inbox/原图.heic", size: file.size, sha256: "a".repeat(64) }));
  expect(screen.getByText("已收件：/project/inbox/原图.heic")).toBeTruthy();
});
it("aborts an old session and suppresses its late receipt", async () => {
  let finish!: (value: Awaited<ReturnType<typeof uploadRemoteFile>>) => void;
  vi.mocked(uploadRemoteFile).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<RemoteFileUpload access={access} />);
  fireEvent.change(screen.getByLabelText("选择本机文件"), { target: { files: [new File(["x"], "x")] } });
  const signal = vi.mocked(uploadRemoteFile).mock.calls[0][3]!;
  view.rerender(<RemoteFileUpload access={{ ...access, sessionId: "new" }} />);
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ status: "completed", path: "/old/x", size: 1, sha256: "a".repeat(64) }));
  expect(screen.queryByText(/已收件/)).toBeNull();
});
it("shows a failure without reporting a successful upload", async () => {
  vi.mocked(uploadRemoteFile).mockRejectedValue(new Error("桌面离线"));
  render(<RemoteFileUpload access={access} />);
  fireEvent.change(screen.getByLabelText("选择本机文件"), { target: { files: [new File(["x"], "x")] } });
  await waitFor(() => expect(screen.getByText(/失败：桌面离线/)).toBeTruthy());
  expect(screen.queryByText(/已收件/)).toBeNull();
});
