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
  /** Visible chip label when it differs from the placeholder token. */
  label?: string;
  kind?: "paste" | "file-selection";
}

export interface DraftContext {
  label: string;
  text: string;
  kind: "file-selection";
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

export function nextContextPlaceholder(label: string, taken: readonly string[]): string {
  const token = `[${label}]`;
  if (!taken.includes(token)) return token;
  let index = 2;
  while (taken.includes(`[${label} #${index}]`)) index += 1;
  return `[${label} #${index}]`;
}

/** Restores every collapsed paste still present in the draft. */
export function expandPastes(draft: string, pastes: readonly PendingPaste[]): string {
  return pastes.reduce(
    (text, paste) => text.split(paste.placeholder).join(paste.text),
    draft,
  );
}

export type DraftSegment =
  | { kind: "text"; text: string }
  | { kind: "paste"; paste: PendingPaste };

/**
 * Splits a draft around its paste tokens. Text segments stay editable;
 * each token renders as one inline chip. A trailing empty segment keeps a
 * caret after the last chip.
 */
export function draftSegments(draft: string, pastes: readonly PendingPaste[]): DraftSegment[] {
  const present = pastes.filter((paste) => paste.placeholder && draft.includes(paste.placeholder));
  if (present.length === 0) return [{ kind: "text", text: draft }];
  const pattern = new RegExp(present.map((paste) => escapeRegExp(paste.placeholder)).join("|"), "g");
  const segments: DraftSegment[] = [];
  let cursor = 0;
  for (const match of draft.matchAll(pattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ kind: "text", text: draft.slice(cursor, start) });
    const paste = present.find((item) => item.placeholder === token);
    if (paste) segments.push({ kind: "paste", paste });
    cursor = start + token.length;
  }
  if (cursor < draft.length || segments.at(-1)?.kind === "paste")
    segments.push({ kind: "text", text: draft.slice(cursor) });
  return segments.length > 0 ? segments : [{ kind: "text", text: draft }];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
