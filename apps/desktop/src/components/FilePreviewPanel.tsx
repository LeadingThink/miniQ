import Editor, { type OnMount } from "@monaco-editor/react";
import {
  Code2,
  Eye,
  ExternalLink,
  FileCode2,
  FolderOpen,
  RotateCcw,
  WrapText,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { editor } from "monaco-editor";
import type { FilePreviewState } from "../hooks/useFilePreview";
import { formatFileSize, openLocalFile, revealLocalFile } from "../localFiles";
import "../monacoSetup";
import {
  BlobPreview,
  DocxPreview,
  PdfPreview,
  PptxPreview,
  SpreadsheetPreview,
  UnsupportedPreview,
} from "./DocumentPreview";
import { MarkdownPreview } from "./MarkdownPreview";

interface FilePreviewPanelProps {
  preview: FilePreviewState;
  workspacePath: string;
  onClose: () => void;
  onOpenFile: (target: NonNullable<FilePreviewState["target"]>) => void;
  onRetry: () => void;
}

const LANGUAGES: Record<string, string> = {
  c: "cpp",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  go: "go",
  h: "cpp",
  hpp: "cpp",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "javascript",
  kt: "kotlin",
  less: "less",
  md: "markdown",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "shell",
  sql: "sql",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

function languageForPath(path: string): string {
  const extension = path.split(/[\\/]/).at(-1)?.split(".").at(-1)?.toLowerCase();
  return extension ? (LANGUAGES[extension] ?? "plaintext") : "plaintext";
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

export function FilePreviewPanel({
  preview,
  workspacePath,
  onClose,
  onOpenFile,
  onRetry,
}: FilePreviewPanelProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [renderAttempt, setRenderAttempt] = useState(0);
  const [markdownSource, setMarkdownSource] = useState(false);
  const [wrapCode, setWrapCode] = useState(false);
  const target = preview.target;
  const path = preview.resolvedPath ?? target?.path ?? "";
  const line = target?.line ?? 1;
  const column = target?.column ?? 1;

  const locate = () => {
    const instance = editorRef.current;
    if (!instance) return;
    const lineNumber = Math.min(Math.max(line, 1), instance.getModel()?.getLineCount() ?? 1);
    instance.setPosition({ lineNumber, column: Math.max(column, 1) });
    instance.revealLineInCenter(lineNumber);
    instance.focus();
  };

  useEffect(locate, [line, column, preview.content]);

  useEffect(() => {
    setActionError(null);
    setRenderError(null);
    setRenderAttempt(0);
    setMarkdownSource(Boolean(target?.line));
    setWrapCode(false);
  }, [path, target?.line]);

  const reportRenderError = useCallback((message: string) => setRenderError(message), []);
  const sourceVisible = preview.kind === "text" || (
    preview.kind === "markdown" && markdownSource
  );

  useEffect(() => {
    if (!sourceVisible) editorRef.current = null;
  }, [sourceVisible]);

  const handleMount: OnMount = (instance) => {
    editorRef.current = instance;
    locate();
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
    <aside className="file-preview-panel" aria-label="文件预览">
      <header className="file-preview-header">
        <FileCode2 size={17} />
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
        {preview.kind === "markdown" && preview.content !== null && (
          <span className="preview-mode-toggle" role="group" aria-label="Markdown 显示模式">
            <button
              type="button"
              className={!markdownSource ? "selected" : ""}
              title="渲染 Markdown"
              aria-label="渲染 Markdown"
              aria-pressed={!markdownSource}
              onClick={() => setMarkdownSource(false)}
            >
              <Eye size={15} />
            </button>
            <button
              type="button"
              className={markdownSource ? "selected" : ""}
              title="查看 Markdown 源码"
              aria-label="查看 Markdown 源码"
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
          className="icon-button"
          title="使用系统默认应用打开"
          aria-label="使用系统默认应用打开"
          disabled={!path}
          onClick={() => void runAction(() => openLocalFile(path, workspacePath))}
        >
          <ExternalLink size={16} />
        </button>
        <button
          className="icon-button"
          title="在文件夹中显示"
          aria-label="在文件夹中显示"
          disabled={!path}
          onClick={() => void runAction(() => revealLocalFile(path, workspacePath))}
        >
          <FolderOpen size={16} />
        </button>
        <button className="icon-button" title="关闭预览" aria-label="关闭预览" onClick={onClose}>
          <X size={17} />
        </button>
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
      <div className="file-preview-content">
        {preview.loading ? (
          <div className="diff-empty">正在读取文件...</div>
        ) : preview.kind === "markdown" && preview.content !== null && !markdownSource ? (
          <MarkdownPreview
            content={preview.content}
            workspacePath={workspacePath}
            currentFilePath={path}
            onOpenFile={onOpenFile}
          />
        ) : sourceVisible && preview.content !== null ? (
          <Editor
            path={path}
            value={preview.content}
            language={languageForPath(path)}
            onMount={handleMount}
            theme="vs"
            options={{
              automaticLayout: true,
              readOnly: true,
              domReadOnly: true,
              minimap: { enabled: false },
              renderLineHighlight: "all",
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              wordWrap: wrapCode ? "on" : "off",
              fontFamily: "JetBrains Mono Variable, Consolas, monospace",
              fontSize: 12.5,
              lineHeight: 20,
              padding: { top: 10, bottom: 16 },
            }}
          />
        ) : preview.dataBase64 && preview.mimeType && (
          preview.kind === "image" ||
          preview.kind === "audio" ||
          preview.kind === "video"
        ) ? (
          <BlobPreview
            dataBase64={preview.dataBase64}
            mimeType={preview.mimeType}
            kind={preview.kind}
            label={fileName(path)}
            onError={reportRenderError}
          />
        ) : preview.kind === "pdf" && preview.dataBase64 ? (
          <PdfPreview key={renderAttempt} dataBase64={preview.dataBase64} onError={reportRenderError} />
        ) : preview.kind === "docx" && preview.dataBase64 ? (
          <DocxPreview key={renderAttempt} dataBase64={preview.dataBase64} onError={reportRenderError} />
        ) : preview.kind === "xlsx" && preview.dataBase64 ? (
          <SpreadsheetPreview key={renderAttempt} dataBase64={preview.dataBase64} onError={reportRenderError} />
        ) : preview.kind === "pptx" && preview.dataBase64 ? (
          <PptxPreview key={renderAttempt} dataBase64={preview.dataBase64} onError={reportRenderError} />
        ) : preview.kind === "unsupported" ? (
          <UnsupportedPreview />
        ) : null}
      </div>
    </aside>
  );
}
