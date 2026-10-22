import type { DiffHunk } from "../types";

/** One `diff --git` block of a unified diff payload. */
export interface UnifiedDiffFile {
  path: string;
  /** Extra metadata line, e.g. a rename; null for a plain modification. */
  note: string | null;
  binary: boolean;
  hunks: DiffHunk[];
}

const GIT_HEADER = /^diff --git ("(?:[^"\\]|\\.)+"|\S+) ("(?:[^"\\]|\\.)+"|\S+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unquote(value: string): string {
  if (!value.startsWith("\"") || !value.endsWith("\"")) return value;
  return value.slice(1, -1).replace(/\\(.)/g, "$1");
}

function stripPrefix(value: string): string {
  return unquote(value).replace(/^[ab]\//, "");
}

function count(value: string | undefined): number {
  return value === undefined ? 1 : Number(value);
}

/** Parse a `git diff --no-color` payload into per-file hunks with line numbers. */
export function parseUnifiedDiff(text: string): UnifiedDiffFile[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const files: UnifiedDiffFile[] = [];
  let current: UnifiedDiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of lines) {
    const header = GIT_HEADER.exec(raw);
    if (header) {
      current = { path: stripPrefix(header[2]), note: null, binary: false, hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    const hunkHeader = HUNK_HEADER.exec(raw);
    if (hunkHeader && current) {
      hunk = {
        oldStart: Number(hunkHeader[1]),
        oldLines: count(hunkHeader[2]),
        newStart: Number(hunkHeader[3]),
        newLines: count(hunkHeader[4]),
        lines: [],
      };
      current.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) {
      current.binary = true;
      hunk = null;
      continue;
    }
    if (raw.startsWith("rename from ")) {
      current.note = `重命名自 ${unquote(raw.slice(12))}`;
      continue;
    }
    if (raw.startsWith("rename to ")) {
      current.path = unquote(raw.slice(10));
      current.note = current.note ? `${current.note} → ${current.path}` : null;
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) {
      hunk.lines.push({ kind: "addition", oldLine: null, newLine: newLine++, content: raw.slice(1) });
    } else if (raw.startsWith("-")) {
      hunk.lines.push({ kind: "deletion", oldLine: oldLine++, newLine: null, content: raw.slice(1) });
    } else if (raw.startsWith(" ") || raw === "") {
      hunk.lines.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, content: raw.slice(1) });
    }
  }
  return files.filter((file) => file.binary || file.hunks.length > 0 || file.note);
}
