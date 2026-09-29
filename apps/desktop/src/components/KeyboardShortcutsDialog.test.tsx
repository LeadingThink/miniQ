// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";

afterEach(cleanup);

it("lists registry shortcuts by section with keycaps and closes on Escape", () => {
  const onClose = vi.fn();
  render(<KeyboardShortcutsDialog open mac onClose={onClose} />);
  const dialog = screen.getByRole("dialog", { name: "键盘快捷键" });
  const navigation = within(dialog).getByRole("region", { name: "导航" });
  const row = within(navigation).getByText("上一个会话").closest(".keyboard-shortcut-row") as HTMLElement;
  expect([...row.querySelectorAll("kbd")].map((kbd) => kbd.textContent)).toEqual(["⌘", "⇧", "["]);
  expect(within(dialog).queryByText("复制当前会话为 Markdown")).toBeNull();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});

it("shows Ctrl keycaps off macOS", () => {
  render(<KeyboardShortcutsDialog open mac={false} onClose={() => {}} />);
  expect(screen.getAllByText("Ctrl").length).toBeGreaterThan(3);
});
