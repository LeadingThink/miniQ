import type { DiffLineKind } from "../types";

export interface InlineDiffLine {
  kind: DiffLineKind;
  content: string;
}

/** Above this many LCS cells the edit is shown as a full replacement:
 * every old line removed, every new line added. No line is dropped. */
const MAX_LCS_CELLS = 250_000;

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Line diff of an exact-string edit (file_edit / file_patch). */
export function lineDiff(before: string, after: string): InlineDiffLine[] {
  const old = splitLines(before);
  const next = splitLines(after);
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let oldEnd = old.length;
  let nextEnd = next.length;
  while (oldEnd > start && nextEnd > start && old[oldEnd - 1] === next[nextEnd - 1]) {
    oldEnd--;
    nextEnd--;
  }
  const head = old.slice(0, start).map((content) => ({ kind: "context" as const, content }));
  const tail = old.slice(oldEnd).map((content) => ({ kind: "context" as const, content }));
  return [...head, ...middleDiff(old.slice(start, oldEnd), next.slice(start, nextEnd)), ...tail];
}

function middleDiff(old: string[], next: string[]): InlineDiffLine[] {
  const removed = old.map((content) => ({ kind: "deletion" as const, content }));
  const added = next.map((content) => ({ kind: "addition" as const, content }));
  if (!old.length || !next.length || old.length * next.length > MAX_LCS_CELLS) {
    return [...removed, ...added];
  }
  const width = next.length + 1;
  const table = new Uint32Array((old.length + 1) * width);
  for (let i = old.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      table[i * width + j] = old[i] === next[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const result: InlineDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < old.length && j < next.length) {
    if (old[i] === next[j]) {
      result.push({ kind: "context", content: old[i] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      result.push(removed[i++]);
    } else {
      result.push(added[j++]);
    }
  }
  return [...result, ...removed.slice(i), ...added.slice(j)];
}

/** Every line of a newly written file, as additions. */
export function additionLines(content: string): InlineDiffLine[] {
  return splitLines(content).map((line) => ({ kind: "addition", content: line }));
}

export interface PatchFile {
  path: string;
  action: string;
  lines: InlineDiffLine[];
}

const PATCH_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;

function patchLine(line: string): InlineDiffLine | null {
  if (line.startsWith("@@")) return null;
  if (line.startsWith("+")) return { kind: "addition", content: line.slice(1) };
  if (line.startsWith("-")) return { kind: "deletion", content: line.slice(1) };
  if (line.startsWith(" ")) return { kind: "context", content: line.slice(1) };
  if (line === "") return { kind: "context", content: "" };
  return null;
}

/** Parse a Codex "*** Begin Patch" block into per-file +/- lines. */
export function parseCodexPatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
    if (line === "*** End Patch") break;
    const header = PATCH_HEADER.exec(line);
    if (header) {
      files.push({ action: header[1], path: header[2].trim(), lines: [] });
      continue;
    }
    const current = files.at(-1);
    if (!current) continue;
    const moved = /^\*\*\* Move to: (.+)$/.exec(line);
    if (moved) {
      current.path = moved[1].trim();
      continue;
    }
    if (line.startsWith("***")) continue;
    const parsed = patchLine(line);
    if (parsed) current.lines.push(parsed);
  }
  return files;
}

/** Lines of a structured apply_patch operation diff (V4A +/- format). */
export function operationDiffLines(diff: string): InlineDiffLine[] {
  return splitLines(diff).flatMap((line) => patchLine(line) ?? []);
}
