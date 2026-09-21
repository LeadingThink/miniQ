import type { KeyboardEvent } from "react";

export const COMPOSER_KEYBOARD_HINT =
  "Enter 发送，Shift＋Enter 换行";

export function canSendComposer(draft: string, attachments: string[]): boolean {
  return draft.trim().length > 0 || attachments.length > 0;
}

export function shouldShowComposerSend(
  busy: boolean,
  draft: string,
  attachments: string[],
): boolean {
  return !busy || canSendComposer(draft, attachments);
}

export function handleComposerKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  onDraftChange: (value: string) => void,
  onSend: () => void,
  options: { enterSends: boolean } = { enterSends: true },
): void {
  if (
    event.key !== "Enter" ||
    event.nativeEvent.isComposing ||
    event.nativeEvent.keyCode === 229 ||
    event.currentTarget.readOnly ||
    event.currentTarget.disabled
  ) return;

  event.preventDefault();
  if (!event.shiftKey && (options.enterSends || event.ctrlKey || event.metaKey)) {
    onSend();
    return;
  }

  // Modified Enter does not reliably insert a native newline across WebViews.
  // Preserve text on both sides of the selection and the controlled draft state.
  const textarea = event.currentTarget;
  const { value, selectionStart: start, selectionEnd: end } = textarea;
  const next = `${value.slice(0, start)}\n${value.slice(end)}`;
  onDraftChange(next);
  requestAnimationFrame(() => {
    if (textarea.isConnected && textarea.value === next)
      textarea.setSelectionRange(start + 1, start + 1);
  });
}
