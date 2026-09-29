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

/** Mention of `@` file references kept short for the placeholder. */
export const COMPOSER_PLACEHOLDER = "随心输入，/ 使用命令与技能，@ 引用文件";

export function handleComposerKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  onDraftChange: (value: string) => void,
  onSend: () => void,
  options: {
    enterSends: boolean;
    /** Returns this session's last user message for ↑ in an empty input. */
    recallLast?: () => string | undefined;
  } = { enterSends: true },
): void {
  if (
    event.key === "ArrowUp" &&
    options.recallLast &&
    !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey &&
    !event.nativeEvent.isComposing &&
    event.nativeEvent.keyCode !== 229 &&
    !event.currentTarget.readOnly &&
    !event.currentTarget.disabled &&
    event.currentTarget.value === ""
  ) {
    const recalled = options.recallLast();
    if (!recalled) return;
    event.preventDefault();
    const textarea = event.currentTarget;
    onDraftChange(recalled);
    requestAnimationFrame(() => {
      if (textarea.isConnected && textarea.value === recalled)
        textarea.setSelectionRange(recalled.length, recalled.length);
    });
    return;
  }
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
