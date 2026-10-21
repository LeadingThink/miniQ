/**
 * Long pastes would bury the draft, so they collapse into a token that is
 * expanded again when the message is sent. The threshold mirrors Codex's
 * `LARGE_PASTE_CHAR_THRESHOLD`.
 */
export const LARGE_PASTE_CHARS = 1000;

export interface PendingPaste {
  /** Token kept in the draft, e.g. `[粘贴内容 4200 字]`. */
  placeholder: string;
  /** Original clipboard text, expanded on submit. */
  text: string;
}

/** Characters, not UTF-16 units: a CJK paste is one unit per glyph. */
export function charCount(text: string): number {
  return Array.from(text).length;
}

export function isLargePaste(text: string): boolean {
  return charCount(text) > LARGE_PASTE_CHARS;
}

/** A token that no other pending paste uses, so two pastes never merge. */
export function nextPlaceholder(text: string, taken: readonly string[]): string {
  const label = `[粘贴内容 ${charCount(text)} 字`;
  if (!taken.includes(`${label}]`)) return `${label}]`;
  let index = 2;
  while (taken.includes(`${label} #${index}]`)) index += 1;
  return `${label} #${index}]`;
}

/** Restores every collapsed paste still present in the draft. */
export function expandPastes(draft: string, pastes: readonly PendingPaste[]): string {
  return pastes.reduce(
    (text, paste) => text.split(paste.placeholder).join(paste.text),
    draft,
  );
}
