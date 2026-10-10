import { useEffect, useState } from "react";
import type { HLJSApi, LanguageFn } from "highlight.js";
import "./syntaxHighlight.css";

type LanguageLoader = () => Promise<{ default: LanguageFn }>;

/** Each grammar is its own lazy chunk; the highlight.js core loads on first use. */
const GRAMMARS: Record<string, LanguageLoader> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  go: () => import("highlight.js/lib/languages/go"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  less: () => import("highlight.js/lib/languages/less"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  php: () => import("highlight.js/lib/languages/php"),
  python: () => import("highlight.js/lib/languages/python"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scss: () => import("highlight.js/lib/languages/scss"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

const EXTENSIONS: Record<string, string> = {
  bash: "bash", sh: "bash", zsh: "bash",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp",
  css: "css",
  go: "go",
  ini: "ini", toml: "ini",
  java: "java",
  cjs: "javascript", js: "javascript", jsx: "javascript", mjs: "javascript",
  json: "json", jsonc: "json",
  kt: "kotlin", kts: "kotlin",
  less: "less",
  markdown: "markdown", md: "markdown", mdx: "markdown",
  php: "php",
  py: "python",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sql: "sql",
  swift: "swift",
  cts: "typescript", mts: "typescript", ts: "typescript", tsx: "typescript",
  html: "xml", svg: "xml", vue: "xml", xml: "xml",
  yaml: "yaml", yml: "yaml",
};

/** highlight.js grammar for a file path, or null for plain text. */
export function languageForPath(path: string): string | null {
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return EXTENSIONS[name.slice(dot + 1).toLowerCase()] ?? null;
}

let core: Promise<HLJSApi> | null = null;
const registered = new Map<string, Promise<HLJSApi>>();

export function loadHighlighter(language: string): Promise<HLJSApi> {
  let ready = registered.get(language);
  if (!ready) {
    core ??= import("highlight.js/lib/core").then((module) => module.default);
    ready = Promise.all([core, GRAMMARS[language]()]).then(([hljs, grammar]) => {
      hljs.registerLanguage(language, grammar.default);
      return hljs;
    });
    ready.catch(() => registered.delete(language));
    registered.set(language, ready);
  }
  return ready;
}

export type LineHighlighter = (text: string) => string;

/** Highlight one source line to escaped HTML. */
export function highlightLine(hljs: HLJSApi, language: string, text: string): string {
  return hljs.highlight(text, { language, ignoreIllegals: true }).value;
}

/** A per-line highlighter for `path`, or null while loading and for plain text. */
export function useLineHighlighter(path: string): LineHighlighter | null {
  const language = languageForPath(path);
  const [loaded, setLoaded] = useState<{ language: string; hljs: HLJSApi } | null>(null);
  useEffect(() => {
    if (!language) return;
    let active = true;
    loadHighlighter(language).then(
      (hljs) => { if (active) setLoaded({ language, hljs }); },
      () => undefined,
    );
    return () => { active = false; };
  }, [language]);
  if (!language || loaded?.language !== language) return null;
  const { hljs } = loaded;
  return (text) => highlightLine(hljs, language, text);
}

/** A code line, syntax-highlighted when a highlighter is ready. highlight.js
 * escapes its input, so its HTML output is safe to inject. */
export function HighlightedCode({ text, highlight }: {
  text: string;
  highlight: LineHighlighter | null;
}) {
  if (!highlight || !text) return <code>{text || " "}</code>;
  return <code dangerouslySetInnerHTML={{ __html: highlight(text) }} />;
}
