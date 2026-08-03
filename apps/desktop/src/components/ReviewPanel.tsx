import { FileCode2, ScanLine, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { LocalFileTarget } from "../localFiles";
import type { DiffHunk, FileDiff, SessionDiff } from "../types";

interface ReviewPanelProps {
  diff: SessionDiff;
  onOpenFile: (target: LocalFileTarget) => void;
  onClose: () => void;
}

function fileState(file: FileDiff): string | null {
  if (!file.oldExists) return "新增";
  if (!file.newExists) return "已删除";
  if (file.binary) return "二进制";
  return null;
}

function hunkLabel(hunk: DiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

function DiffFileView({
  file,
  onOpenFile,
}: {
  file: FileDiff;
  onOpenFile: (target: LocalFileTarget) => void;
}) {
  if (file.binary) return <div className="diff-empty">二进制文件已修改，无法显示逐行差异。</div>;
  if (file.hunks.length === 0) return <div className="diff-empty">没有文本差异。</div>;
  return (
    <div className="diff-file-view">
      {file.hunks.map((hunk, hunkIndex) => (
        <section className="diff-hunk" key={`${file.path}:${hunkIndex}`}>
          <div className="diff-hunk-header">{hunkLabel(hunk)}</div>
          {hunk.lines.map((line, lineIndex) => (
            <button
              type="button"
              className={`diff-line ${line.kind}`}
              key={`${hunkIndex}:${lineIndex}`}
              disabled={!file.newExists}
              title={file.newExists ? "在文件预览中定位此行" : undefined}
              onClick={() =>
                onOpenFile({
                  path: file.absolutePath,
                  line: line.newLine ?? hunk.newStart,
                  column: null,
                })
              }
            >
              <span className="diff-line-number">{line.oldLine ?? ""}</span>
              <span className="diff-line-number">{line.newLine ?? ""}</span>
              <span className="diff-sign">
                {line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " "}
              </span>
              <code>{line.content || " "}</code>
            </button>
          ))}
        </section>
      ))}
    </div>
  );
}

export function ReviewPanel({ diff, onOpenFile, onClose }: ReviewPanelProps) {
  const [selectedPath, setSelectedPath] = useState(diff.files[0]?.path ?? "");
  const selected = useMemo(
    () => diff.files.find((file) => file.path === selectedPath) ?? diff.files[0],
    [diff.files, selectedPath],
  );

  useEffect(() => {
    if (!diff.files.some((file) => file.path === selectedPath)) {
      setSelectedPath(diff.files[0]?.path ?? "");
    }
  }, [diff.files, selectedPath]);

  return (
    <aside className="review-panel" aria-label="代码修改审阅">
      <header className="review-header">
        <div>
          <strong>审阅</strong>
          <span>{diff.files.length} 个文件</span>
        </div>
        <div className="diff-stats">
          <span className="diff-add">+{diff.additions}</span>
          <span className="diff-delete">-{diff.deletions}</span>
        </div>
        <button className="icon-button" title="关闭审阅" aria-label="关闭审阅" onClick={onClose}>
          <X size={17} />
        </button>
      </header>

      <nav className="review-files" aria-label="已修改文件">
        {diff.files.map((file) => (
          <button
            type="button"
            className={file.path === selected?.path ? "selected" : ""}
            key={file.path}
            title={file.absolutePath}
            onClick={() => setSelectedPath(file.path)}
          >
            <FileCode2 size={15} />
            <span>{file.path}</span>
            {fileState(file) && <small>{fileState(file)}</small>}
            <span className="file-diff-stats">
              <b>+{file.additions}</b> <i>-{file.deletions}</i>
            </span>
          </button>
        ))}
      </nav>

      {selected && (
        <div className="review-content">
          <div className="review-file-header">
            <FileCode2 size={16} />
            <span title={selected.absolutePath}>{selected.path}</span>
            <span className="diff-add">+{selected.additions}</span>
            <span className="diff-delete">-{selected.deletions}</span>
            <button
              className="icon-button"
              title="在文件预览中打开"
              aria-label={`打开 ${selected.path}`}
              disabled={!selected.newExists}
              onClick={() =>
                onOpenFile({
                  path: selected.absolutePath,
                  line: selected.hunks[0]?.newStart ?? 1,
                  column: null,
                })
              }
            >
              <ScanLine size={15} />
            </button>
          </div>
          <DiffFileView file={selected} onOpenFile={onOpenFile} />
        </div>
      )}
    </aside>
  );
}
