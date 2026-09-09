// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OpenPreviewButton } from "./OpenPreviewButton";
const open = vi.hoisted(() => vi.fn());
vi.mock("../runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open }));
afterEach(cleanup);
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
it("does not open a picker result in a different session", async () => {
  let resolve!: (value: string) => void;
  open.mockReturnValue(
    new Promise<string>((done) => {
      resolve = done;
    }),
  );
  const onOpen = vi.fn();
  const props = {
    workspacePath: "/project",
    scope: "one",
    onOpen,
    onError: vi.fn(),
  };
  const view = render(<OpenPreviewButton {...props} />);
  await act(async () => fireEvent.click(screen.getByRole("button")));
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "浏览文件…" })),
  );
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ defaultPath: "/project", multiple: false }),
  );
  view.rerender(<OpenPreviewButton {...props} scope="two" />);
  await act(async () => resolve("/project/report.md"));
  expect(onOpen).not.toHaveBeenCalled();
});
it("opens a chosen file in its original workspace and treats cancel as no action", async () => {
  const onOpen = vi.fn();
  open.mockResolvedValueOnce(null).mockResolvedValueOnce("/project/report.md");
  render(
    <OpenPreviewButton
      workspacePath="/project"
      scope="one"
      onOpen={onOpen}
      onError={vi.fn()}
    />,
  );
  await act(async () => fireEvent.click(screen.getByRole("button")));
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "浏览文件…" })),
  );
  expect(onOpen).not.toHaveBeenCalled();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "浏览文件…" })),
  );
  expect(onOpen).toHaveBeenCalledWith({
    path: "/project/report.md",
    line: null,
    column: null,
  });
});
it("opens relative paths without a model request and restores focus on cancel", () => {
  const onOpen = vi.fn();
  render(
    <OpenPreviewButton
      workspacePath="/project"
      scope="one"
      onOpen={onOpen}
      onError={vi.fn()}
    />,
  );
  const trigger = screen.getByRole("button", { name: "打开项目文件预览" });
  fireEvent.click(trigger);
  fireEvent.change(screen.getByLabelText("预览文件路径"), {
    target: { value: "docs/report.md" },
  });
  fireEvent.click(screen.getByRole("button", { name: "打开预览" }));
  expect(onOpen).toHaveBeenCalledWith({
    path: "/project/docs/report.md",
    line: null,
    column: null,
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger);
  fireEvent(
    screen.getByRole("dialog"),
    new Event("cancel", { bubbles: true, cancelable: true }),
  );
  expect(document.activeElement).toBe(trigger);
});
