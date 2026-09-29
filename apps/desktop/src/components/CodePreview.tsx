import Editor, { type OnMount } from "@monaco-editor/react";
import "../monacoSetup";
import { useRef } from "react";
import { useEditorTheme } from "../hooks/useEditorTheme";

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
  const extension = path
    .split(/[\\/]/)
    .at(-1)
    ?.split(".")
    .at(-1)
    ?.toLowerCase();
  return extension ? (LANGUAGES[extension] ?? "plaintext") : "plaintext";
}

export default function CodePreview(props: {
  path: string;
  content: string;
  wrap: boolean;
  onMount: OnMount;
  /** ⌘L / Ctrl+L and Ctrl+G inside the editor open the "转到行" input. */
  onGoToLine?: () => void;
}) {
  const beforeMount = useEditorTheme();
  const goToLine = useRef(props.onGoToLine);
  goToLine.current = props.onGoToLine;
  const handleMount: OnMount = (instance, monaco) => {
    instance.addAction({
      id: "miniq.goToLine",
      label: "转到行",
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL,
        monaco.KeyMod.WinCtrl | monaco.KeyCode.KeyG,
      ],
      run: () => goToLine.current?.(),
    });
    props.onMount(instance, monaco);
  };
  return (
    <Editor
      saveViewState={false}
      value={props.content}
      path={props.path}
      language={languageForPath(props.path)}
      onMount={handleMount}
      beforeMount={beforeMount}
      theme="miniq"
      options={{
        automaticLayout: true,
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        renderLineHighlight: "all",
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        wordWrap: props.wrap ? "on" : "off",
        fontFamily: "JetBrains Mono Variable, Consolas, monospace",
        fontSize: 12.5,
        lineHeight: 20,
        padding: { top: 10, bottom: 16 },
      }}
    />
  );
}
