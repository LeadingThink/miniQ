import { useMemo, useState } from "react";
import type { DiffHunk, DiffLine } from "../types";
import { HighlightedCode, useLineHighlighter } from "./syntaxHighlight";
import { parseUnifiedDiff, type UnifiedDiffFile } from "./unifiedDiff";

/** Rows rendered before the "show more" button. */
const FIRST_BATCH = 400;
const BATCH_STEP = 800;
/** Unchanged lines kept on each side of a change. Matches `git diff -U3`. */
const CONTEXT_LINES = 3;

type DiffRow =
  | { kind: "file"; label: string }
  | { kind: "hunk"; label: string }
  | { kind: "fold"; lines: DiffLine[] }
  | { kind: "empty"; text: string }
  | { kind: "line"; line: DiffLine };

function hunkLabel(hunk: DiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

/** Keep changed lines plus a few unchanged lines. Collapse the rest. */
function focusLines(lines: DiffLine[]): DiffRow[] {
  const keep = lines.map((line) => line.kind !== "context");
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].kind === "context") continue;
    for (let neighbor = index - CONTEXT_LINES; neighbor <= index + CONTEXT_LINES; neighbor += 1) {
      if (neighbor >= 0 && neighbor < lines.length) keep[neighbor] = true;
    }
  }
  const rows: DiffRow[] = [];
  let folded: DiffLine[] = [];
  const flush = () => {
    if (folded.length > 0) rows.push({ kind: "fold", lines: folded });
    folded = [];
  };
  lines.forEach((line, index) => {
    if (keep[index]) {
      flush();
      rows.push({ kind: "line", line });
    } else {
      folded = [...folded, line];
    }
  });
  flush();
  return rows;
}

function buildRows(files: UnifiedDiffFile[], path: string): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const file of files) {
    const label = file.path || path;
    if (label) rows.push({ kind: "file", label: file.note ? `${label} · ${file.note}` : label });
    if (file.binary) {
      rows.push({ kind: "empty", text: "二进制文件已修改，无法显示逐行差异。" });
      continue;
    }
    if (file.hunks.length === 0) {
      rows.push({ kind: "empty", text: "文件内容没有变化。" });
      continue;
    }
    for (const hunk of file.hunks) {
      rows.push({ kind: "hunk", label: hunkLabel(hunk) });
      rows.push(...focusLines(hunk.lines));
    }
  }
  return rows;
}

function sign(line: DiffLine): string {
  if (line.kind === "addition") return "+";
  if (line.kind === "deletion") return "-";
  return " ";
}

/** Color a raw unified-diff line when structured parsing finds no hunks. */
function rawLineKind(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "addition";
  if (line.startsWith("-") && !line.startsWith("---")) return "deletion";
  if (line.startsWith("@@")) return "hunk";
  return "meta";
}

function DiffCodeLine({ line, highlight }: {
  line: DiffLine;
  highlight: ReturnType<typeof useLineHighlighter>;
}) {
  return (
    <div className={`diff-line ${line.kind}`}>
      <span className="diff-line-number">{line.oldLine ?? ""}</span>
      <span className="diff-line-number">{line.newLine ?? ""}</span>
      <span className="diff-sign">{sign(line)}</span>
      <HighlightedCode text={line.content} highlight={highlight} />
    </div>
  );
}

function RawDiff({ diff }: { diff: string }) {
  const lines = diff.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  return (
    <div className="git-raw-diff" role="region" aria-label="原始差异">
      {lines.map((line, index) => (
        <div className={`git-raw-line ${rawLineKind(line)}`} key={index}>{line || " "}</div>
      ))}
    </div>
  );
}

/** Line-by-line rendering of a `git diff` payload, syntax-highlighted for `path`. */
export function UnifiedDiffView({ diff, path }: { diff: string; path: string }) {
  const highlight = useLineHighlighter(path);
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const rows = useMemo(() => buildRows(files, path), [files, path]);
  const [visible, setVisible] = useState(FIRST_BATCH);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  if (files.length === 0) return <RawDiff diff={diff} />;
  const shown = rows.slice(0, visible);
  const remaining = rows.length - shown.length;
  return (
    <div className="git-diff-view">
      {shown.map((row, index) => {
        if (row.kind === "file")
          return <div className="git-diff-file" key={index} title={row.label}>{row.label}</div>;
        if (row.kind === "hunk")
          return <div className="diff-hunk-header" key={index}>{row.label}</div>;
        if (row.kind === "fold" && !expanded.has(index))
          return (
            <button
              type="button"
              className="git-diff-fold"
              key={index}
              onClick={() => setExpanded((current) => new Set(current).add(index))}
            >
              展开 {row.lines.length} 行未改动代码
            </button>
          );
        if (row.kind === "fold")
          return row.lines.map((line, lineIndex) => (
            <DiffCodeLine highlight={highlight} key={`${index}:${lineIndex}`} line={line} />
          ));
        if (row.kind === "empty")
          return <div className="diff-empty" key={index}>{row.text}</div>;
        return <DiffCodeLine highlight={highlight} key={index} line={row.line} />;
      })}
      {remaining > 0 && (
        <button
          type="button"
          className="git-diff-more"
          onClick={() => setVisible((value) => value + BATCH_STEP)}
        >
          显示更多差异（剩余 {remaining} 行）
        </button>
      )}
    </div>
  );
}
