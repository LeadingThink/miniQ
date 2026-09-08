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

export function isComposerSendKey(
  key: string,
  shiftKey: boolean,
  isComposing: boolean,
): boolean {
  return key === "Enter" && !shiftKey && !isComposing;
}
