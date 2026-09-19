// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RemoteFileDownload } from "./RemoteFileDownload";
import { readRemoteFile } from "../remoteFiles";

const access = vi.hoisted(() => ({
  current: { client: { mode: "remote", call: vi.fn() }, sessionId: "one" },
}));
vi.mock("../sessionFileAccess", () => ({
  useSessionFileAccess: () => access.current,
}));
vi.mock("../remoteFiles", () => ({ readRemoteFile: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: vi.fn(() => "blob:file"),
      revokeObjectURL: vi.fn(),
    }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  Object.defineProperty(navigator, "canShare", {
    configurable: true,
    value: vi.fn(() => true),
  });
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  vi.mocked(readRemoteFile).mockResolvedValue({
    path: "/work/result.pdf",
    kind: "pdf",
    mimeType: "application/pdf",
    content: null,
    dataBase64: btoa("pdf"),
    size: 3,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("keeps a user-activated save link and shares the downloaded file without transferring it again", async () => {
  const onError = vi.fn();
  render(<RemoteFileDownload path="/work/result.pdf" onError={onError} />);
  fireEvent.click(screen.getByRole("button", { name: "下载到当前设备" }));
  const save = await screen.findByRole("link", {
    name: "文件已就绪，保存到当前设备",
  });
  expect(save.getAttribute("download")).toBe("result.pdf");
  expect(save.getAttribute("href")).toBe("blob:file");
  fireEvent.click(screen.getByRole("button", { name: "分享或存储文件" }));
  expect(navigator.share).toHaveBeenCalledWith({
    files: [expect.objectContaining({ name: "result.pdf" })],
  });
  expect(readRemoteFile).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
});

it("reuses a complete preview without another remote request and preserves Unicode content", async () => {
  render(
    <RemoteFileDownload
      path="/work/报告.md"
      onError={vi.fn()}
      preview={{
        path: "/work/报告.md",
        mimeType: "text/markdown",
        content: "中文结果",
        dataBase64: null,
      }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "下载到当前设备" }));
  await screen.findByRole("link");
  expect(readRemoteFile).not.toHaveBeenCalled();
  const file = vi.mocked(URL.createObjectURL).mock.calls[0][0] as File;
  expect(file.size).toBe(new TextEncoder().encode("中文结果").length);
});

it("aborts a previous session's transfer and ignores its late result", async () => {
  let finish!: (result: Awaited<ReturnType<typeof readRemoteFile>>) => void;
  vi.mocked(readRemoteFile).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(
    <RemoteFileDownload path="/work/result.pdf" onError={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "下载到当前设备" }));
  const signal = vi.mocked(readRemoteFile).mock.calls[0][1].signal!;
  access.current = { ...access.current, sessionId: "two" };
  view.rerender(
    <RemoteFileDownload path="/work/result.pdf" onError={vi.fn()} />,
  );
  expect(signal.aborted).toBe(true);
  await act(async () =>
    finish({
      path: "/work/result.pdf",
      kind: "pdf",
      mimeType: "application/pdf",
      content: null,
      dataBase64: "",
      size: 0,
    }),
  );
  expect(screen.queryByRole("link")).toBeNull();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("releases prepared object URLs after Safari has had time to read them", async () => {
  const view = render(
    <RemoteFileDownload path="/work/result.pdf" onError={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "下载到当前设备" }));
  await screen.findByRole("link");
  vi.useFakeTimers();
  view.unmount();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60_000);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:file");
});

it("treats closing the system share sheet as cancellation, not a failure", async () => {
  const onError = vi.fn();
  vi.mocked(navigator.share).mockRejectedValue(
    new DOMException("cancelled", "AbortError"),
  );
  render(<RemoteFileDownload path="/work/result.pdf" onError={onError} />);
  fireEvent.click(screen.getByRole("button", { name: "下载到当前设备" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "分享或存储文件" }),
  );
  await waitFor(() => expect(navigator.share).toHaveBeenCalled());
  expect(onError).not.toHaveBeenCalled();
});
