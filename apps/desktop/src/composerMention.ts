import { fuzzyMatch } from "./fuzzyMatch";

/** A workspace path offered by the @ file mention popover. */
export interface MentionFile {
  /** Path relative to the session working directory, using `/`. */
  path: string;
  directory: boolean;
}

export interface MentionToken {
  /** Index of the `@` character. */
  start: number;
  /** Index just past the token (the token may continue after the caret). */
  end: number;
  /** Text typed between `@` and the caret. */
  query: string;
}

export const MENTION_LIMIT = 30;

/**
 * Finds the `@` token being typed at the caret. The `@` must start the input
 * or follow whitespace, so e-mail addresses such as `a@b` never trigger it.
 */
export function mentionToken(value: string, caret: number): MentionToken | null {
  if (caret < 0 || caret > value.length) return null;
  let start = caret - 1;
  while (start >= 0 && !/\s/.test(value[start]) && value[start] !== "@") start -= 1;
  if (start < 0 || value[start] !== "@") return null;
  if (start > 0 && !/\s/.test(value[start - 1])) return null;
  let end = caret;
  while (end < value.length && !/\s/.test(value[end])) end += 1;
  return { start, end, query: value.slice(start + 1, caret) };
}

/** `@path`, or `` @`path with spaces` `` when the path contains whitespace. */
export function formatMention(path: string): string {
  return /\s/.test(path) ? `@\`${path}\`` : `@${path}`;
}

/** Replaces the token with the mention plus a trailing space. */
export function applyMention(
  value: string,
  token: Pick<MentionToken, "start" | "end">,
  path: string,
): { value: string; cursor: number } {
  const after = value.slice(token.end);
  const inserted = `${formatMention(path)}${after.startsWith(" ") ? "" : " "}`;
  const cursor = token.start + inserted.length + (after.startsWith(" ") ? 1 : 0);
  return { value: `${value.slice(0, token.start)}${inserted}${after}`, cursor };
}

function baseName(path: string): string {
  const trimmed = path.replace(/\/$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

function depth(path: string): number {
  return path.replace(/\/$/, "").split("/").length;
}

/** Fuzzy-ranks candidates, preferring file-name hits, then shorter paths. */
export function filterMentionFiles(
  files: MentionFile[],
  query: string,
  limit = MENTION_LIMIT,
): MentionFile[] {
  const needle = query.trim();
  if (!needle) {
    return [...files]
      .sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path))
      .slice(0, limit);
  }
  const ranked: Array<{ file: MentionFile; score: number }> = [];
  for (const file of files) {
    const full = fuzzyMatch(file.path, needle);
    const name = fuzzyMatch(baseName(file.path), needle);
    if (!full && !name) continue;
    const score = Math.max(full?.score ?? -Infinity, (name?.score ?? -Infinity) + 20);
    ranked.push({ file, score });
  }
  return ranked
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.file.path.length - b.file.path.length ||
        a.file.path.localeCompare(b.file.path),
    )
    .slice(0, limit)
    .map((item) => item.file);
}

/**
 * Inserts `text` into the draft. A focused input receives it at the
 * selection; otherwise it is appended, separated from existing text by a
 * space (inline text) or a blank line (block text such as quotes).
 */
export function insertComposerText(
  value: string,
  text: string,
  selection: { start: number; end: number } | null,
): { value: string; cursor: number } {
  if (selection) {
    const start = Math.max(0, Math.min(selection.start, value.length));
    const end = Math.max(start, Math.min(selection.end, value.length));
    const next = `${value.slice(0, start)}${text}${value.slice(end)}`;
    return { value: next, cursor: start + text.length };
  }
  let separator = "";
  if (value && !/\s$/.test(value)) {
    separator = text.includes("\n") || text.startsWith(">") ? "\n\n" : " ";
  } else if (value.endsWith("\n") && !value.endsWith("\n\n") && text.startsWith(">")) {
    separator = "\n";
  }
  const next = `${value}${separator}${text}`;
  return { value: next, cursor: next.length };
}

/** Markdown blockquote of the selection, followed by a blank line. */
export function quoteMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "").split("\n");
  return `${lines.map((line) => (line.trim() ? `> ${line}` : ">")).join("\n")}\n\n`;
}

export const COMPOSER_INSERT_EVENT = "miniq:composer-insert";

/** Sends text to the visible composer (see `useComposerInsert`). */
export function dispatchComposerInsert(text: string): void {
  window.dispatchEvent(new CustomEvent(COMPOSER_INSERT_EVENT, { detail: { text } }));
}
