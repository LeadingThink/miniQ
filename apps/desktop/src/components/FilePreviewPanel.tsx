import type { OnMount } from "@monaco-editor/react";
import {
  Code2,
  Eye,
  ExternalLink,
  FileCode2,
  FileText,
  Image,
  Music,
  Video,
  Table2,
  Presentation,
  FolderOpen,
  RotateCcw,
  WrapText,
  Maximize2,
  Minimize2,
  MessageSquare,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { editor } from "monaco-editor";
import type { FilePreviewState } from "../hooks/useFilePreview";
import { formatFileSize, openLocalFile, revealLocalFile } from "../localFiles";
import {
  BlobPreview,
  DocxPreview,
  PdfPreview,
  PptxPreview,
  SpreadsheetPreview,
  UnsupportedPreview,
} from "./DocumentPreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { SvgPreview } from "./SvgPreview";
import { DelimitedPreview } from "./DelimitedPreview";
import { CopyButton } from "./CopyButton";
import { HtmlPreview } from "./HtmlPreview";
import { isHtmlFile } from "../htmlPreview";
import { isTauriRuntime } from "../runtime";
import { useSessionFileAccess } from "../sessionFileAccess";
import { RemoteFileDownload } from "./RemoteFileDownload";
import { PreviewTabs } from "./PreviewTabs";
import type { LocalFileTarget } from "../localFiles";
import "./PreviewFocus.css";
import {
  PreviewViewProvider,
  PreviewViewStore,
  usePreviewCache,
  usePreviewValue,
} from "../previewViewState";

interface FilePreviewPanelProps {
  viewStore?: PreviewViewStore;
  viewScope?: string;
  preview: FilePreviewState;
  workspacePath: string;
  workspacePaths: readonly string[];
  onClose: () => void;
  onOpenFile: (target: NonNullable<FilePreviewState["target"]>) => void;
  onRetry: () => void;
  tabs?: LocalFileTarget[];
  onCloseTab?: (path: string) => void;
  onDiscuss?: (path: string) => void;
}

interface PreviewPanelContentProps extends FilePreviewPanelProps {
  expanded: boolean;
  onToggleExpanded: () => void;
}

const CodePreview = lazy(() => import("./CodePreview"));

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

export function FilePreviewPanel(props: FilePreviewPanelProps) {
  const [localStore] = useState(() => new PreviewViewStore());
  const [expanded, setExpanded] = useState(false);
  const path = props.preview.resolvedPath ?? props.preview.target?.path ?? "";
  const scope = props.viewScope ?? props.workspacePath;
  return (
    <PreviewViewProvider
      store={props.viewStore ?? localStore}
      scope={scope}
      path={path}
    >
      <PreviewPanelContent
        {...props}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((value) => !value)}
      />
    </PreviewViewProvider>
  );
}

function PreviewPanelContent({
  preview,
  workspacePath,
  workspacePaths,
  onClose,
  onOpenFile,
  onRetry,
  tabs = [],
  onCloseTab,
  onDiscuss,
  expanded,
  onToggleExpanded,
}: PreviewPanelContentProps) {
  const contentId = useId();
  const access = useSessionFileAccess();
  const remote = !isTauriRuntime() || access?.client?.mode === "remote";
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderAttempt, setRenderAttempt] = useState(0);
  const [markdownSource, setMarkdownSource] = usePreviewValue(
    "source",
    Boolean(preview.target?.line),
  );
  const [wrapCode, setWrapCode] = usePreviewValue("wrapCode", false);
  const viewCache = usePreviewCache();
  const target = preview.target;
  const path = preview.resolvedPath ?? target?.path ?? "";
  const line = target?.line ?? 1;
  const column = target?.column ?? 1;

  const locate = () => {
    const instance = editorRef.current;
    if (!instance) return;
    const lineNumber = Math.min(
      Math.max(line, 1),
      instance.getModel()?.getLineCount() ?? 1,
    );
    instance.setPosition({ lineNumber, column: Math.max(column, 1) });
    instance.revealLineInCenter(lineNumber);
    instance.focus();
  };

  useEffect(() => {
    if (target?.line) locate();
  }, [line, column, preview.content]);

  useEffect(() => {
    setActionError(null);
    setRenderError(null);
    setRenderAttempt(0);
    if (target?.line) setMarkdownSource(true);
  }, [path, target?.line, preview.content, preview.dataBase64]);

  const reportRenderError = useCallback(
    (message: string) => setRenderError(message),
    [],
  );
  const renderable =
    preview.kind === "markdown" ||
    (preview.kind === "text" &&
      (isHtmlFile(path) || /\.(svg|csv|tsv)$/i.test(path)));
  const TypeIcon =
    preview.kind === "image" || /\.svg$/i.test(path)
      ? Image
      : preview.kind === "audio"
        ? Music
        : preview.kind === "video"
          ? Video
          : preview.kind === "xlsx" || /\.(csv|tsv)$/i.test(path)
            ? Table2
            : preview.kind === "pptx"
              ? Presentation
              : ["markdown", "docx", "pdf"].includes(preview.kind ?? "")
                ? FileText
                : FileCode2;
  const sourceVisible =
    (preview.kind === "text" && !renderable) || (renderable && markdownSource);

  useEffect(() => {
    if (!sourceVisible) editorRef.current = null;
  }, [sourceVisible]);

  const handleMount: OnMount = (instance) => {
    editorRef.current = instance;
    const saved = viewCache.get("codeState") as
      editor.ICodeEditorViewState | undefined;
    if (saved) instance.restoreViewState(saved);
    if (target?.line) locate();
    const save = () => viewCache.set("codeState", instance.saveViewState());
    const scroll = instance.onDidScrollChange(save);
    const cursor = instance.onDidChangeCursorPosition(save);
    instance.onDidDispose(() => {
      scroll.dispose();
      cursor.dispose();
    });
  };

  const runAction = async (action: () => Promise<void>) => {
    try {
      await action();
      setActionError(null);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <aside
      className={`file-preview-panel${expanded ? " preview-expanded" : ""}`}
      aria-label="文件预览"
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onToggleExpanded();
        }
      }}
    >
      {onCloseTab && (
        <PreviewTabs
          tabs={tabs}
          active={path}
          id={contentId}
          onSelect={onOpenFile}
          onClose={onCloseTab}
        />
      )}
      <header className="file-preview-header">
        <TypeIcon size={17} />
        <div>
          <strong>{fileName(path) || "文件预览"}</strong>
          <span title={path}>{path}</span>
        </div>
        {(target?.line || preview.size !== null) && (
          <small>
            {target?.line ? `行 ${target.line}` : ""}
            {target?.line && preview.size !== null ? " · " : ""}
            {preview.size !== null ? formatFileSize(preview.size) : ""}
          </small>
        )}
        <button
          className="icon-button"
          title="关闭预览"
          aria-label="关闭预览"
          onClick={onClose}
        >
          <X size={17} />
        </button>
        <section className="file-preview-tools" aria-label="文件操作">
          {onDiscuss && <button type="button" className="icon-button" aria-label="针对这个文件继续提问" title="针对这个文件继续提问" disabled={!path} onClick={() => onDiscuss(path)}><MessageSquare size={16} /></button>}
          <button
            type="button"
            className="icon-button"
            aria-label={expanded ? "恢复分栏预览" : "展开预览"}
            title={expanded ? "恢复分栏预览 (Esc)" : "展开预览"}
            aria-pressed={expanded}
            onClick={(event) => {
              // WebKit does not focus buttons on mouse clicks by default.
              // Keep Escape inside the preview after expanding it.
              event.currentTarget.focus({ preventScroll: true });
              onToggleExpanded();
            }}
          >
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          {renderable && preview.content !== null && (
            <span
              className="preview-mode-toggle"
              role="group"
              aria-label="文件显示模式"
            >
              <button
                type="button"
                className={!markdownSource ? "selected" : ""}
                title="渲染预览"
                aria-label="渲染预览"
                aria-pressed={!markdownSource}
                onClick={() => setMarkdownSource(false)}
              >
                <Eye size={15} />
              </button>
              <button
                type="button"
                className={markdownSource ? "selected" : ""}
                title="查看源码"
                aria-label="查看源码"
                aria-pressed={markdownSource}
                onClick={() => setMarkdownSource(true)}
              >
                <Code2 size={15} />
              </button>
            </span>
          )}
          {sourceVisible && (
            <button
              type="button"
              className={`icon-button${wrapCode ? " active" : ""}`}
              title={wrapCode ? "关闭长行折行" : "开启长行折行"}
              aria-label={wrapCode ? "关闭长行折行" : "开启长行折行"}
              aria-pressed={wrapCode}
              onClick={() => setWrapCode((value) => !value)}
            >
              <WrapText size={16} />
            </button>
          )}
          <CopyButton
            content={path}
            label="复制文件路径"
            onError={setActionError}
          />
          <button
            type="button"
            className="icon-button"
            title="重新读取文件"
            aria-label="重新读取文件"
            disabled={preview.loading || !path}
            onClick={onRetry}
          >
            <RotateCcw size={15} />
          </button>
          {remote ? <RemoteFileDownload path={path} onError={setActionError} /> : <button
            className="icon-button"
            title="使用系统默认应用打开"
            aria-label="使用系统默认应用打开"
            disabled={!path}
            onClick={() =>
              void runAction(() =>
                openLocalFile(path, workspacePath, workspacePaths),
              )
            }
          >
            <ExternalLink size={16} />
          </button>}
          {!remote && <button
            className="icon-button"
            title="在文件夹中显示"
            aria-label="在文件夹中显示"
            disabled={!path}
            onClick={() =>
              void runAction(() =>
                revealLocalFile(path, workspacePath, workspacePaths),
              )
            }
          >
            <FolderOpen size={16} />
          </button>}
        </section>
      </header>
      {(preview.error || actionError || renderError) && (
        <div className="review-error preview-error" role="alert">
          <span>无法打开：{preview.error ?? actionError ?? renderError}</span>
          {(renderError || preview.error) && (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                if (preview.error) onRetry();
                else {
                  setRenderError(null);
                  setRenderAttempt((value) => value + 1);
                }
              }}
            >
              <RotateCcw size={13} />
              重试渲染
            </button>
          )}
        </div>
      )}
      <div
        className="file-preview-content"
        id={contentId}
        role={tabs.length ? "tabpanel" : undefined}
        aria-label={tabs.length ? fileName(path) : undefined}
      >
        {preview.loading ? (
          <div className="file-preview-loading" role="status">
            <span>正在读取文件…{preview.progress && ` ${formatFileSize(preview.progress.received)} / ${formatFileSize(preview.progress.total)}`}</span>
            {preview.progress && <progress aria-label="文件加载进度" value={preview.progress.received} max={preview.progress.total || 1} />}
            <button type="button" className="ghost" onClick={onClose}>取消加载</button>
          </div>
        ) : preview.kind === "markdown" &&
          preview.content !== null &&
          !markdownSource ? (
          <MarkdownPreview
            content={preview.content}
            workspacePath={workspacePath}
            workspacePaths={workspacePaths}
            currentFilePath={path}
            onOpenFile={onOpenFile}
          />
        ) : renderable &&
          !markdownSource &&
          preview.content !== null &&
          /\.svg$/i.test(path) ? (
          <SvgPreview
            key={renderAttempt}
            content={preview.content}
            label={fileName(path)}
            onError={reportRenderError}
          />
        ) : renderable &&
          !markdownSource &&
          preview.content !== null &&
          /\.(csv|tsv)$/i.test(path) ? (
          <DelimitedPreview
            key={renderAttempt}
            content={preview.content}
            path={path}
            onError={reportRenderError}
          />
        ) : renderable && !markdownSource && preview.content !== null ? (
          <HtmlPreview
            file={{ path, workspacePath, workspacePaths }}
            key={path}
            content={preview.content}
            label={fileName(path)}
          />
        ) : sourceVisible && preview.content !== null ? (
          <Suspense
            fallback={<div className="diff-empty">正在加载代码视图...</div>}
          >
            <CodePreview
              path={path}
              content={preview.content}
              wrap={wrapCode}
              onMount={handleMount}
            />
          </Suspense>
        ) : preview.dataBase64 &&
          preview.mimeType &&
          (preview.kind === "image" ||
            preview.kind === "audio" ||
            preview.kind === "video") ? (
          <BlobPreview
            key={`${path}:${renderAttempt}`}
            dataBase64={preview.dataBase64}
            mimeType={preview.mimeType}
            kind={preview.kind}
            label={fileName(path)}
            onError={reportRenderError}
          />
        ) : preview.kind === "pdf" && preview.dataBase64 ? (
          <PdfPreview
            key={renderAttempt}
            dataBase64={preview.dataBase64}
            onError={reportRenderError}
          />
        ) : preview.kind === "docx" && preview.dataBase64 ? (
          <DocxPreview
            key={renderAttempt}
            dataBase64={preview.dataBase64}
            onError={reportRenderError}
          />
        ) : preview.kind === "xlsx" && preview.dataBase64 ? (
          <SpreadsheetPreview
            key={renderAttempt}
            dataBase64={preview.dataBase64}
            onError={reportRenderError}
          />
        ) : preview.kind === "pptx" && preview.dataBase64 ? (
          <PptxPreview
            key={renderAttempt}
            dataBase64={preview.dataBase64}
            onError={reportRenderError}
          />
        ) : preview.kind === "unsupported" ? (
          <UnsupportedPreview remote={remote} />
        ) : null}
      </div>
    </aside>
  );
}
