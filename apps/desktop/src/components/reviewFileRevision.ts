import type { FileDiff } from "../types";

/** A compact UI revision key; never used for security or file integrity checks. */
export function reviewFileRevision(file: FileDiff): string {
  let first = 2166136261;
  let second = 5381;
  let length = 0;
  const add = (value: string | number | boolean | null) => {
    const text = String(value);
    length += text.length;
    for (let index = 0; index <= text.length; index++) {
      const code = index === text.length ? 0 : text.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second, 33) ^ code;
    }
  };
  for (const value of [
    file.absolutePath,
    file.oldExists,
    file.newExists,
    file.binary,
    file.additions,
    file.deletions,
  ])
    add(value);
  for (const hunk of file.hunks) {
    for (const value of [
      hunk.oldStart,
      hunk.oldLines,
      hunk.newStart,
      hunk.newLines,
    ])
      add(value);
    for (const line of hunk.lines) {
      for (const value of [line.kind, line.oldLine, line.newLine, line.content])
        add(value);
    }
  }
  return `${first >>> 0}:${second >>> 0}:${length}`;
}
