import type { OnMount } from "@monaco-editor/react";
import { breadcrumb, breadcrumbSegments } from "../fileTreeModel";
import { FileKindIcon } from "./FileKindIcon";
import {
  Code2,
  Eye,
  ExternalLink,
  ChevronRight,
  FolderOpen,
  RotateCcw,
  WrapText,
  Maximize2,
  Minimize2,
  MessageSquare,
  MessageSquarePlus,
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
  LegacyOfficePreview,
  PdfPreview,
  PptxPreview,
  SpreadsheetPreview,
  UnsupportedPreview,
} from "./DocumentPreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { SvgPreview } from "./SvgPreview";
import { DelimitedPreview } from "./DelimitedPreview";
import { PreviewOptionsMenu } from "./PreviewOptionsMenu";
import { addPathToChat, parseLineNumber } from "../fileActions";
import { HtmlPreview } from "./HtmlPreview";
import { isHtmlFile } from "../htmlPreview";
import { isTauriRuntime } from "../runtime";
import { useSessionFileAccess } from "../sessionFileAccess";
import { RemoteFileDownload } from "./RemoteFileDownload";
import { ExternalEditorMenu } from "./ExternalEditorMenu";
import { PreviewTabs } from "./PreviewTabs";
import { PreviewSelection } from "./PreviewSelection";
import { usePreviewSelection } from "../hooks/usePreviewSelection";
import type { LocalFileTarget } from "../localFiles";
import "./PreviewFocus.css";
import "./FilePreviewMobile.css";
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
  authorizedFiles?: readonly string[];
  onClose: () => void;
  onOpenFile: (target: NonNullable<FilePreviewState["target"]>) => void;
  onRetry: () => void;
  onAuthorizeFile?: (
    target: NonNullable<FilePreviewState["target"]>,
    chooseReplacement?: boolean,
  ) => void;
  tabs?: LocalFileTarget[];
  onCloseTab?: (path: string) => void;
  onCloseOtherTabs?: (path: string) => void;
  onCloseAllTabs?: () => void;
  onReopenClosedTab?: () => void;
  canReopenClosedTab?: boolean;
  onDiscuss?: (path: string, selection?: string) => void;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  withinWorkbench?: boolean;
  /** Reveal a breadcrumb folder in the project file tree. */
  onRevealDirectory?: (path: string) => void;
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
  const [localExpanded, setExpanded] = useState(false);
  const expanded = props.expanded ?? localExpanded;
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
        onToggleExpanded={props.onToggleExpanded ?? (() => setExpanded((value) => !value))}
      />
    </PreviewViewProvider>
  );
}

function PreviewPanelContent({
  preview,
  workspacePath,
  workspacePaths,
  authorizedFiles = [],
  onClose,
  onOpenFile,
  onRetry,
  onAuthorizeFile,
  tabs = [],
  onCloseTab,
  onCloseOtherTabs,
  onCloseAllTabs,
  onReopenClosedTab,
  canReopenClosedTab,
  onDiscuss,
  withinWorkbench = false,
  onRevealDirectory,
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
  const deniedExternalFile = preview.error?.includes("拒绝打开工作区外的文件") ?? false;
  const missingLocalFile = preview.error?.includes("无法访问文件") ?? false;
  const canChooseLocalFile = Boolean(
    (deniedExternalFile || missingLocalFile) &&
    target &&
    onAuthorizeFile &&
    !remote,
  );
  const selection = usePreviewSelection(path, preview.content ?? preview.dataBase64);
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
  const roots = workspacePaths.length ? workspacePaths : [workspacePath];
  const segments = breadcrumbSegments(path, roots);
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
    const selected = instance.onDidChangeCursorSelection(() => {
      const range = instance.getSelection();
      const text = range && !range.isEmpty() ? instance.getModel()?.getValueInRange(range) : "";
      selection.setText(text && range ? `第 ${range.startLineNumber}–${range.endLineNumber} 行：\n${text}` : "");
    });
    instance.onDidDispose(() => {
      scroll.dispose();
      cursor.dispose();
      selected.dispose();
    });
  };

  const [goToLine, setGoToLine] = useState<{
    value: string;
    max: number;
    error: string | null;
  } | null>(null);
  const goToInput = useRef<HTMLInputElement>(null);
  const openGoToLine = () => {
    const max = editorRef.current?.getModel()?.getLineCount() ??
      (preview.content ?? "").split("\n").length;
    const current = editorRef.current?.getPosition()?.lineNumber;
    setGoToLine({ value: current ? String(current) : "", max, error: null });
    requestAnimationFrame(() => {
      goToInput.current?.focus();
      goToInput.current?.select();
    });
  };
  const closeGoToLine = () => {
    setGoToLine(null);
    editorRef.current?.focus();
  };
  const submitGoToLine = () => {
    if (!goToLine) return;
    const parsed = parseLineNumber(goToLine.value, goToLine.max);
    if (parsed.line === null) {
      setGoToLine({ ...goToLine, error: parsed.error });
      return;
    }
    setGoToLine(null);
    const instance = editorRef.current;
    if (!instance) return;
    instance.revealLineInCenter(parsed.line);
    instance.setPosition({ lineNumber: parsed.line, column: 1 });
    instance.focus();
  };
  const findInFile = () => {
    const instance = editorRef.current;
    if (!instance) return;
    instance.focus();
    const action = instance.getAction("actions.find");
    if (action) void action.run();
    else setActionError("当前编辑器不支持文件内查找");
  };
  useEffect(() => {
    if (!sourceVisible) setGoToLine(null);
  }, [sourceVisible, path]);

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
      className={`file-preview-panel${expanded && !withinWorkbench ? " preview-expanded" : ""}`}
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
          onCloseOthers={onCloseOtherTabs}
          onCloseAll={onCloseAllTabs}
          onReopenClosed={onReopenClosedTab}
          canReopenClosed={canReopenClosedTab}
        />
      )}
      <header className="file-preview-header">
        <FileKindIcon name={fileName(path)} size={17} />
        <div className="file-preview-location">
          <strong>{fileName(path) || "文件预览"}</strong>
          {onRevealDirectory && segments.length > 1 ? (
            <nav className="file-preview-breadcrumb" aria-label="文件位置" title={path}>
              {segments.map((segment, index) => (
                <span key={segment.path} className="file-preview-crumb">
                  {index > 0 && <ChevronRight size={12} aria-hidden />}
                  {segment.directory ? (
                    <button
                      type="button"
                      title={`在文件树中显示 ${segment.path}`}
                      onClick={() => onRevealDirectory(segment.path)}
                    >
                      {segment.label}
                    </button>
                  ) : (
                    <span aria-current="page">{segment.label}</span>
                  )}
                </span>
              ))}
            </nav>
          ) : (
            <details key={path} className="file-preview-path">
              <summary title={path}><span className="file-path-summary">{breadcrumb(path, roots)}</span><span className="file-path-hint">文件路径</span></summary>
              <span>{path}</span>
            </details>
          )}
        </div>
        {(target?.line || preview.size !== null) && (
          <small>
            {target?.line ? `行 ${target.line}` : ""}
            {target?.line && preview.size !== null ? " · " : ""}
            {preview.size !== null ? formatFileSize(preview.size) : ""}
          </small>
        )}
        {!withinWorkbench && <button
          className="icon-button"
          title="关闭预览"
          aria-label="关闭预览"
          onClick={onClose}
        >
          <X size={17} />
        </button>}
        <section className="file-preview-tools" aria-label="文件操作">
          {onDiscuss && <button type="button" className="icon-button file-preview-discuss" aria-label="针对这个文件继续提问" title="针对这个文件继续提问" disabled={!path} onClick={() => onDiscuss(path)}><MessageSquare size={16} /><span>继续提问</span></button>}
          {!withinWorkbench && <button
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
          </button>}
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
          <button
            type="button"
            className="icon-button"
            title="添加到聊天"
            aria-label="添加到聊天"
            disabled={!path}
            onClick={() => addPathToChat(path, roots)}
          >
            <MessageSquarePlus size={16} />
          </button>
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
          {remote ? <RemoteFileDownload path={path} onError={setActionError}
            preview={preview.mimeType ? { path, mimeType: preview.mimeType, content: preview.content, dataBase64: preview.dataBase64 } : undefined} /> : <button
            className="icon-button"
            title="使用系统默认应用打开"
            aria-label="使用系统默认应用打开"
            disabled={!path}
            onClick={() =>
              void runAction(() =>
                openLocalFile(path, workspacePath, workspacePaths, authorizedFiles),
              )
            }
          >
            <ExternalLink size={16} />
          </button>}
          {!remote && <ExternalEditorMenu
            target={{ path, line: target?.line, column: target?.column }}
            onError={setActionError}
          />}
          <PreviewOptionsMenu
            path={path}
            roots={roots}
            content={preview.content}
            onReveal={
              remote
                ? undefined
                : () => revealLocalFile(path, workspacePath, workspacePaths, authorizedFiles)
            }
            onGoToLine={sourceVisible && preview.content !== null ? openGoToLine : undefined}
            onFind={sourceVisible && preview.content !== null ? findInFile : undefined}
            onError={setActionError}
          />
        </section>
      </header>
      {goToLine && (
        <form
          className="file-preview-goto"
          role="search"
          aria-label="转到行"
          onSubmit={(event) => {
            event.preventDefault();
            submitGoToLine();
          }}
        >
          <label>
            <span>转到行</span>
            <input
              ref={goToInput}
              type="text"
              inputMode="numeric"
              aria-label="转到行"
              aria-invalid={Boolean(goToLine.error)}
              placeholder={`1–${goToLine.max}`}
              value={goToLine.value}
              onChange={(event) =>
                setGoToLine({ ...goToLine, value: event.target.value, error: null })
              }
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeGoToLine();
                }
              }}
            />
          </label>
          <button type="submit" className="ghost">跳转</button>
          <button type="button" className="ghost" onClick={closeGoToLine}>取消</button>
          {goToLine.error && <small role="alert">{goToLine.error}</small>}
        </form>
      )}
      {(preview.error || actionError || renderError) && (
        <div className="review-error preview-error" role="alert">
          <span>无法打开：{preview.error ?? actionError ?? renderError}</span>
          {canChooseLocalFile && target && onAuthorizeFile && (
            <button
              type="button"
              className="ghost"
              onClick={() => onAuthorizeFile(target, missingLocalFile)}
            >
              <FolderOpen size={14} />
              {deniedExternalFile ? "允许并打开" : "选择并打开"}
            </button>
          )}
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
      {onDiscuss && <PreviewSelection text={selection.text} onClear={selection.clear}
        onDiscuss={() => { onDiscuss(path, selection.text); selection.clear(); }} />}
      <div
        ref={selection.ref}
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
              onGoToLine={openGoToLine}
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
          ) : preview.kind === "officeLegacy" && !remote ? (
            <LegacyOfficePreview
              key={renderAttempt}
              path={path}
              workspacePath={workspacePath}
              workspacePaths={workspacePaths}
              authorizedFiles={authorizedFiles}
              onError={reportRenderError}
            />
          ) : preview.kind === "officeLegacy" ? (
            <UnsupportedPreview remote />
        ) : preview.kind === "unsupported" ? (
          <UnsupportedPreview remote={remote} />
        ) : null}
      </div>
    </aside>
  );
}
