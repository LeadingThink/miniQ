// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExternalEditorMenu } from "./ExternalEditorMenu";

const openInEditor = vi.hoisted(() => vi.fn());
vi.mock("../externalEditor", () => ({ openInEditor }));
afterEach(() => {
  cleanup();
  openInEditor.mockReset();
});

it("offers keyboard navigation and restores focus after choosing an editor", async () => {
  const target = { path: "/tmp/report.md", line: 3, column: 2 };
  render(<ExternalEditorMenu target={target} />);
  const trigger = screen.getByRole("button", { name: "在外部编辑器中打开" });
  fireEvent.click(trigger);
  const vscode = screen.getByRole("menuitem", { name: "用 VS Code 打开" });
  await waitFor(() => expect(document.activeElement).toBe(vscode));
  fireEvent.keyDown(vscode, { key: "ArrowDown" });
  const cursor = screen.getByRole("menuitem", { name: "用 Cursor 打开" });
  expect(document.activeElement).toBe(cursor);
  fireEvent.click(cursor);
  expect(openInEditor).toHaveBeenCalledWith(target, "cursor");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("reports an unavailable editor without leaving an unusable menu open", async () => {
  openInEditor.mockRejectedValue(new Error("没有安装 Zed"));
  const onError = vi.fn();
  render(<ExternalEditorMenu target={{ path: "/tmp/report.md" }} onError={onError} />);
  fireEvent.click(screen.getByRole("button", { name: "在外部编辑器中打开" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "用 Zed 打开" }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("没有安装 Zed"));
  expect(screen.queryByRole("menu")).toBeNull();
});
