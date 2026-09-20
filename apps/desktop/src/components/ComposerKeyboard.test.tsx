// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Composer, ComposerCard } from "./Composer";
import { COMPOSER_KEYBOARD_HINT } from "../composerInput";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

function setup(busy = false, onSend = vi.fn().mockResolvedValue(true)) {
  render(<Composer busy={busy} draftKey="keyboard-test" onSend={onSend} onCancel={vi.fn()} />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "消息" });
  return { input, onSend };
}

it.each([{}, { shiftKey: true }, { metaKey: true }])("sends with Enter modifiers %j", async (modifiers) => {
  const { input, onSend } = setup();
  fireEvent.change(input, { target: { value: "第一行\n第二行" } });
  await act(async () => { fireEvent.keyDown(input, { key: "Enter", ...modifiers }); });
  expect(onSend).toHaveBeenCalledExactlyOnceWith("第一行\n第二行", []);
  expect(input.value).toBe("");
});

it.each([{ start: 2, end: 2, value: "甲乙\n丙丁" }, { start: 1, end: 3, value: "甲\n丁" }])(
  "inserts Ctrl+Enter at the selection and persists the draft: %j", ({ start, end, value }) => {
    let frame: FrameRequestCallback | undefined;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frame = callback; return 1; });
    const { input, onSend } = setup();
    fireEvent.change(input, { target: { value: "甲乙丙丁" } });
    input.setSelectionRange(start, end);
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(input.value).toBe(value);
    expect(localStorage.getItem("miniq.draft.keyboard-test")).toBe(value);
    act(() => frame?.(0));
    expect(input.selectionStart).toBe(start + 1);
    expect(input.selectionEnd).toBe(start + 1);
    expect(onSend).not.toHaveBeenCalled();
  },
);

it("gives Ctrl precedence when both Ctrl and Shift are held", () => {
  const { input, onSend } = setup();
  fireEvent.change(input, { target: { value: "第一行" } });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, shiftKey: true });
  expect(input.value).toBe("第一行\n");
  expect(onSend).not.toHaveBeenCalled();
});

it.each([{ isComposing: true }, { keyCode: 229 }])("leaves IME confirmation untouched: %j", (ime) => {
  const { input, onSend } = setup();
  fireEvent.change(input, { target: { value: "中文候选词" } });
  for (const modifiers of [{}, { shiftKey: true }, { ctrlKey: true }]) {
    expect(fireEvent.keyDown(input, { key: "Enter", ...modifiers, ...ime })).toBe(true);
  }
  expect(input.value).toBe("中文候选词");
  expect(onSend).not.toHaveBeenCalled();
});

it("keeps instructions visible and associated with the input after typing", () => {
  const { input } = setup();
  expect(input.placeholder).toBe("随心输入，/ 使用命令与技能");
  fireEvent.change(input, { target: { value: "草稿" } });
  expect(screen.getByText(COMPOSER_KEYBOARD_HINT).id).toBe(input.getAttribute("aria-describedby"));
});

it("does not edit or resend while a send is pending", async () => {
  let finish!: (value: boolean) => void;
  const onSend = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const { input } = setup(false, onSend);
  fireEvent.change(input, { target: { value: "等待发送" } });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(input.readOnly).toBe(true);
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  expect(input.value).toBe("等待发送");
  expect(onSend).toHaveBeenCalledTimes(1);
  await act(async () => finish(true));
});

it("uses the same shortcuts while a task is running and new content will be queued", async () => {
  const { input, onSend } = setup(true);
  fireEvent.change(input, { target: { value: "下一步" } });
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: `${input.value}保留原文` } });
  await act(async () => { fireEvent.keyDown(input, { key: "Enter", shiftKey: true }); });
  expect(onSend).toHaveBeenCalledExactlyOnceWith("下一步\n保留原文", []);
});

it("does not let Ctrl+Enter select a slash command", () => {
  Element.prototype.scrollIntoView = vi.fn();
  const onSelect = vi.fn();
  const onSend = vi.fn();
  render(<ComposerCard busy={false} placeholder="消息" onSend={onSend} slashCommands={[
    { id: "new", name: "新建会话", description: "开始新的工作", group: "会话", onSelect },
  ]} />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "/" } });
  expect(screen.getByRole("listbox")).toBeTruthy();
  fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
  expect(input.value).toBe("/\n");
  expect(onSelect).not.toHaveBeenCalled();
  expect(onSend).not.toHaveBeenCalled();
});
