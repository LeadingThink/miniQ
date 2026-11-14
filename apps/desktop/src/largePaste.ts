/**
 * Shared helpers for the 800-character paste boundary, draft context chips,
 * and historical sent-message paste rendering.
 */
export const LARGE_PASTE_CHARS = 800;

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

export function nextContextPlaceholder(label: string, taken: readonly string[]): string {
  const token = `[${label}]`;
  if (!taken.includes(token)) return token;
  let index = 2;
  while (taken.includes(`[${label} #${index}]`)) index += 1;
  return `[${label} #${index}]`;
}

/** Restores every collapsed paste still present in the draft. */
export function expandPastes(draft: string, pastes: readonly PendingPaste[]): string {
  return draftSegments(draft, pastes)
    .map((segment) => segment.kind === "text" ? segment.text : segment.paste.text)
    .join("");
}

export type DraftSegment =
  | { kind: "text"; text: string }
  | { kind: "paste"; paste: PendingPaste };

export type SentMessageSegment =
  | { kind: "text"; text: string }
  | { kind: "paste"; text: string; label: string };

const TRAILING_TEXT_CHARS = 500;

/**
 * Recovers the visible shape of a sent long paste without changing the stored
 * message. The pasted document starts the message and may contain short title
 * lines; only a short trailing instruction after a newline is kept separate.
 */
export function sentMessageSegments(content: string): SentMessageSegment[] {
  if (!isLargePaste(content)) return [{ kind: "text", text: content }];
  const boundaries = [...content.matchAll(/\r?\n/g)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const last = [...boundaries].reverse().find((boundary) =>
    isLargePaste(content.slice(0, boundary.start).trim())
      && charCount(content.slice(boundary.end).trim()) <= TRAILING_TEXT_CHARS,
  );
  if (!last) return [{ kind: "text", text: content }];
  const paste = content.slice(0, last.start).trim();
  const after = content.slice(last.end).trim();
  if (!isLargePaste(paste) || !after)
    return [{ kind: "text", text: content }];
  return [
    { kind: "paste", text: paste, label: `粘贴内容 ${charCount(paste)} 字` },
    { kind: "text", text: after },
  ];
}

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
