// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { captureEditingTarget, runEditingAction } from "./menuEditing";

afterEach(() => { document.body.innerHTML = ""; vi.restoreAllMocks(); });

it("pastes the complete clipboard into the saved selection using the native undo stack", async () => {
  const text = "完整内容\n第二行\n".repeat(1000);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: vi.fn(async () => text) } });
  const editor = document.createElement("textarea");
  editor.value = "before selection after";
  document.body.append(editor);
  editor.focus(); editor.setSelectionRange(7, 16);
  const restore = captureEditingTarget();
  editor.blur();
  const execute = vi.fn(() => {
    expect(document.activeElement).toBe(editor);
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([7, 16]);
    return true;
  });
  Object.defineProperty(document, "execCommand", { configurable: true, value: execute });
  await runEditingAction("paste", restore);
  expect(execute).toHaveBeenCalledExactlyOnceWith("insertText", false, text);
});

it("surfaces clipboard denial without editing the document", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText: vi.fn(async () => { throw new Error("Clipboard denied"); }) } });
  const restore = vi.fn();
  await expect(runEditingAction("paste", restore)).rejects.toThrow("Clipboard denied");
  expect(restore).not.toHaveBeenCalled();
});
