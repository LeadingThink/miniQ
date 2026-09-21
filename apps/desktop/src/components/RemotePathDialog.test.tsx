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
import { isRemoteAbsolutePath, RemotePathDialog } from "./RemotePathDialog";

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (
    this: HTMLDialogElement,
  ) {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("opens an exact remote path with spaces without invoking a local picker or shell", async () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <RemotePathDialog
      host="devbox"
      purpose="project"
      onSubmit={onSubmit}
      onClose={onClose}
    />,
  );
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "~/work" } });
  fireEvent.click(screen.getByRole("button", { name: "确定" }));
  expect(screen.getByRole("alert").textContent).toContain("绝对路径");
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "/home/user/项目 文件" } });
  fireEvent.click(screen.getByRole("button", { name: "确定" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(onSubmit).toHaveBeenCalledWith("/home/user/项目 文件");
});

it("keeps the path available for correction if the remote folder is inaccessible", async () => {
  const onClose = vi.fn();
  render(
    <RemotePathDialog
      host="devbox"
      purpose="project"
      onSubmit={async () => {
        throw new Error("not found on devbox");
      }}
      onClose={onClose}
    />,
  );
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "/missing" },
  });
  fireEvent.click(screen.getByRole("button", { name: "确定" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "not found on devbox",
  );
  expect(onClose).not.toHaveBeenCalled();
  expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe(
    "/missing",
  );
});

it.each(["/Users/name/文件.pdf", "C:\\Users\\name\\report.pdf", "D:/资料/文件.pdf", "\\\\server\\share\\report.pdf"])("accepts remote absolute path %s", (path) => {
  expect(isRemoteAbsolutePath(path)).toBe(true);
});

it.each(["report.pdf", "C:report.pdf", "\\report.pdf", "/work/file\n.pdf", "/file\0.pdf"])("rejects non-absolute or invalid path %s", (path) => {
  expect(isRemoteAbsolutePath(path)).toBe(false);
});

it("submits a Windows path unchanged and explains that this does not upload the phone file", async () => {
  const onSubmit = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(<RemotePathDialog host="办公室 Windows" purpose="attachment" onSubmit={onSubmit} onClose={onClose} />);
  const input = screen.getByRole("textbox");
  expect(input.getAttribute("autocapitalize")).toBe("none");
  expect(screen.getByText(/此入口不会上传手机/)).toBeTruthy();
  fireEvent.change(input, { target: { value: "C:\\Users\\name\\项目说明.pdf" } });
  fireEvent.click(screen.getByRole("button", { name: "确定" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledExactlyOnceWith("C:\\Users\\name\\项目说明.pdf"));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("ignores duplicate submits while the remote operation is pending", async () => {
  let finish!: () => void;
  const onSubmit = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  render(<RemotePathDialog host="远程电脑" purpose="attachment" onSubmit={onSubmit} onClose={vi.fn()} />);
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "/work/资料.pdf" } });
  const form = input.closest("form")!;
  act(() => { fireEvent.submit(form); fireEvent.submit(form); });
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith("/work/资料.pdf");
  await act(async () => finish());
});
