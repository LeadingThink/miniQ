import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileCode2,
  RefreshCw,
  ScanLine,
  Search,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { LocalFileTarget } from "../localFiles";
import type { DiffHunk, FileDiff, SessionDiff } from "../types";
import {
  PreviewViewProvider,
  PreviewViewStore,
  usePreviewScroll,
  usePreviewValue,
} from "../previewViewState";
import { reviewFileRevision } from "./reviewFileRevision";
import "./ReviewPanel.css";

interface ReviewPanelProps {
  diff: SessionDiff;
  onOpenFile: (target: LocalFileTarget) => void;
  onClose: () => void;
  error?: string | null;
  onRetry?: () => void;
  viewStore?: PreviewViewStore;
  viewScope?: string;
}

const DIFF_LINE_BATCH = 300;

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
  const [visibleLines, setVisibleLines] = usePreviewValue(
    `diff-lines:${file.absolutePath}`,
    DIFF_LINE_BATCH,
  );
  const scroll = usePreviewScroll<HTMLDivElement>(`diff:${file.absolutePath}`);
  const totalLines = useMemo(
    () => file.hunks.reduce((total, hunk) => total + hunk.lines.length, 0),
    [file],
  );
  const visibleHunks = useMemo(() => {
    let remaining = visibleLines;
    const result: DiffHunk[] = [];
    for (const hunk of file.hunks) {
      if (remaining <= 0) break;
      result.push({ ...hunk, lines: hunk.lines.slice(0, remaining) });
      remaining -= hunk.lines.length;
    }
    return result;
  }, [file, visibleLines]);
  if (file.binary)
    return (
      <div className="diff-empty">二进制文件已修改，无法显示逐行差异。</div>
    );
  if (file.hunks.length === 0)
    return <div className="diff-empty">没有文本差异。</div>;
  return (
    <div className="diff-file-view" {...scroll}>
      {visibleHunks.map((hunk, hunkIndex) => (
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
                {line.kind === "addition"
                  ? "+"
                  : line.kind === "deletion"
                    ? "-"
                    : " "}
              </span>
              <code>{line.content || " "}</code>
            </button>
          ))}
        </section>
      ))}
      {totalLines > DIFF_LINE_BATCH && (
        <div className="review-load-more">
          <span role="status">
            已显示 {Math.min(visibleLines, totalLines)} / {totalLines} 行
          </span>
          {visibleLines < totalLines && (
            <button
              type="button"
              className="ghost"
              onClick={() =>
                setVisibleLines((count) => count + DIFF_LINE_BATCH)
              }
            >
              继续加载差异（
              {Math.min(DIFF_LINE_BATCH, totalLines - visibleLines)} 行）
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ReviewFileList({
  files,
  selected,
  reviewed,
  onSelect,
}: {
  files: FileDiff[];
  selected?: FileDiff;
  reviewed: ReadonlySet<string>;
  onSelect: (path: string) => void;
}) {
  return (
    <nav className="review-files" aria-label="已修改文件">
      {files.map((file) => (
        <button
          type="button"
          className={file.path === selected?.path ? "selected" : ""}
          key={file.path}
          title={file.absolutePath}
          aria-current={file.path === selected?.path ? "true" : undefined}
          onClick={() => onSelect(file.path)}
        >
          <FileCode2 size={15} />
          <span>{file.path}</span>
          <span className="review-file-badges">
            {fileState(file) && <small>{fileState(file)}</small>}
            {reviewed.has(file.path) && <Check size={13} aria-label="已审阅" />}
          </span>
          <span className="file-diff-stats">
            <b>+{file.additions}</b> <i>-{file.deletions}</i>
          </span>
        </button>
      ))}
    </nav>
  );
}

function ReviewSelection({
  selected,
  onOpenFile,
  reviewed,
  onToggleReviewed,
}: {
  selected: FileDiff;
  onOpenFile: ReviewPanelProps["onOpenFile"];
  reviewed: boolean;
  onToggleReviewed: () => void;
}) {
  return (
    <div className="review-content">
      <div className="review-file-header">
        <FileCode2 size={16} />
        <span title={selected.absolutePath}>{selected.path}</span>
        <span className="diff-add">+{selected.additions}</span>
        <span className="diff-delete">-{selected.deletions}</span>
        <button
          type="button"
          className="icon-button"
          title={reviewed ? "标记为未审阅" : "标记为已审阅"}
          aria-label={reviewed ? "标记为未审阅" : "标记为已审阅"}
          aria-pressed={reviewed}
          onClick={onToggleReviewed}
        >
          <Check size={16} />
        </button>
        <button
          type="button"
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
      <DiffFileView
        key={selected.absolutePath}
        file={selected}
        onOpenFile={onOpenFile}
      />
    </div>
  );
}

function ReviewNavigation({
  filter,
  onFilter,
  files,
  selected,
  onSelect,
}: {
  filter: string;
  onFilter: (value: string) => void;
  files: FileDiff[];
  selected?: FileDiff;
  onSelect: (path: string) => void;
}) {
  const index = selected ? files.indexOf(selected) : -1;
  return (
    <div className="review-navigation">
      <label className="review-filter">
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          aria-label="筛选已修改文件"
          placeholder="筛选文件路径…"
          value={filter}
          onChange={(event) => onFilter(event.target.value)}
        />
      </label>
      {filter && (
        <button
          type="button"
          className="icon-button"
          title="清除文件筛选"
          aria-label="清除文件筛选"
          onClick={() => onFilter("")}
        >
          <X size={14} />
        </button>
      )}
      <div
        className="review-file-navigation"
        role="group"
        aria-label="文件导航"
      >
        <button
          type="button"
          className="icon-button"
          title="上一个文件"
          aria-label="上一个文件"
          disabled={index <= 0}
          onClick={() => onSelect(files[index - 1].path)}
        >
          <ChevronLeft size={16} />
        </button>
        <span role="status">
          {index + 1} / {files.length}
        </span>
        <button
          type="button"
          className="icon-button"
          title="下一个文件"
          aria-label="下一个文件"
          disabled={index < 0 || index >= files.length - 1}
          onClick={() => onSelect(files[index + 1].path)}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

export function ReviewPanel(props: ReviewPanelProps) {
  const [localStore] = useState(() => new PreviewViewStore());
  return (
    <PreviewViewProvider
      store={props.viewStore ?? localStore}
      scope={props.viewScope ?? "review"}
      path="workbench://review"
    >
      <ReviewPanelContent {...props} />
    </PreviewViewProvider>
  );
}

function ReviewPanelContent({
  diff,
  onOpenFile,
  onClose,
  error,
  onRetry,
}: ReviewPanelProps) {
  const [filter, setFilter] = usePreviewValue("filter", "");
  const [selectedPath, setSelectedPath] = usePreviewValue(
    "selectedPath",
    diff.files[0]?.path ?? "",
  );
  const [reviewed, setReviewed] = usePreviewValue(
    "reviewed",
    new Map<string, string>(),
  );
  const reviewedPaths = useMemo(
    () =>
      new Set(
        diff.files
          .filter(
            (file) =>
              reviewed.has(file.path) &&
              reviewed.get(file.path) === reviewFileRevision(file),
          )
          .map((file) => file.path),
      ),
    [diff.files, reviewed],
  );
  const files = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return query
      ? diff.files.filter((file) =>
          file.path.toLocaleLowerCase().includes(query),
        )
      : diff.files;
  }, [diff.files, filter]);
  const selected = files.find((file) => file.path === selectedPath) ?? files[0];
  const toggleReviewed = () => {
    if (!selected) return;
    const next = new Map(reviewed);
    if (reviewedPaths.has(selected.path)) next.delete(selected.path);
    else next.set(selected.path, reviewFileRevision(selected));
    setReviewed(next);
  };
  return (
    <aside className="review-panel" aria-label="代码修改审阅">
      <header className="review-header">
        <div>
          <strong>审阅</strong>
          <span>
            {diff.files.length} 个文件 · 已审阅 {reviewedPaths.size}
          </span>
        </div>
        <div className="diff-stats">
          <span className="diff-add">+{diff.additions}</span>
          <span className="diff-delete">-{diff.deletions}</span>
        </div>
        {onRetry && (
          <button
            type="button"
            className="icon-button"
            title="刷新审阅"
            aria-label="刷新审阅"
            onClick={onRetry}
          >
            <RefreshCw size={16} />
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          title="关闭审阅"
          aria-label="关闭审阅"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>
      {error && (
        <div className="review-error" role="alert">
          <span>{error}</span>
          {onRetry && (
            <button type="button" className="ghost" onClick={onRetry}>
              重试
            </button>
          )}
        </div>
      )}
      {diff.files.length > 0 && (
        <>
          <ReviewNavigation
            filter={filter}
            onFilter={setFilter}
            files={files}
            selected={selected}
            onSelect={setSelectedPath}
          />
          <ReviewFileList
            files={files}
            selected={selected}
            reviewed={reviewedPaths}
            onSelect={setSelectedPath}
          />
        </>
      )}
      {selected ? (
        <ReviewSelection
          selected={selected}
          reviewed={reviewedPaths.has(selected.path)}
          onToggleReviewed={toggleReviewed}
          onOpenFile={onOpenFile}
        />
      ) : (
        !error && (
          <div className="diff-empty" role="status">
            {diff.files.length
              ? "没有匹配的文件，试试其他路径或清除筛选。"
              : "暂无文件改动。任务修改文件后，可在这里逐项审阅。"}
          </div>
        )
      )}
    </aside>
  );
}
