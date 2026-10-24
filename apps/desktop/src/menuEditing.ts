export type EditingAction = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll";

/** Preserve the editor selection while the menu temporarily owns focus. */
export function captureEditingTarget(element = document.activeElement) {
  const target = element instanceof HTMLElement ? element : null;
  const input = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
  const selection = input && input.selectionStart !== null
    ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } : null;
  const ranges = Array.from({ length: window.getSelection()?.rangeCount ?? 0 }, (_, index) => window.getSelection()!.getRangeAt(index).cloneRange());
  return () => {
    if (target?.isConnected) target.focus({ preventScroll: true });
    if (input && selection) input.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
    else if (ranges.length) {
      const current = window.getSelection();
      current?.removeAllRanges();
      ranges.forEach((range) => current?.addRange(range));
    }
  };
}

export async function runEditingAction(action: EditingAction, restore: () => void) {
  if (action === "paste") {
    const text = await navigator.clipboard.readText();
    restore();
    // execCommand retains the browser's native undo history and input events.
    if (text && !document.execCommand("insertText", false, text)) throw new Error("请先选择可编辑的输入框");
    return;
  }
  restore();
  document.execCommand(action);
}
