import Editor, { type OnMount } from "@monaco-editor/react";
import { ExternalLink, FileCode2, FolderOpen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { editor } from "monaco-editor";
import type { FilePreviewState } from "../hooks/useFilePreview";
import { openLocalFile, revealLocalFile } from "../localFiles";
import "../monacoSetup";

interface FilePreviewPanelProps {
  preview: FilePreviewState;
  workspacePath: string;
  onClose: () => void;
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
}: FilePreviewPanelProps) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
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
  }, [path]);

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
        {target?.line && <small>行 {target.line}</small>}
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
      {(preview.error || actionError) && (
        <div className="review-error">无法打开：{preview.error ?? actionError}</div>
      )}
      <div className="file-preview-content">
        {preview.loading ? (
          <div className="diff-empty">正在读取文件...</div>
        ) : preview.content !== null ? (
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
              wordWrap: "off",
              fontFamily: "JetBrains Mono Variable, Consolas, monospace",
              fontSize: 12.5,
              lineHeight: 20,
              padding: { top: 10, bottom: 16 },
            }}
          />
        ) : null}
      </div>
    </aside>
  );
}
