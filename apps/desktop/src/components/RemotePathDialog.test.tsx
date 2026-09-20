// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RemotePathDialog } from "./RemotePathDialog";

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
