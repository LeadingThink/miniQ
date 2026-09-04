import { Check, Copy, FileText } from "lucide-react";
import { createElement, isValidElement, useEffect, useRef, useState } from "react";
import type {
  AnchorHTMLAttributes,
  ComponentPropsWithoutRef,
  MouseEvent,
  ReactNode,
} from "react";
import "katex/dist/katex.min.css";
import rehypeKatex from "rehype-katex";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { openExternalUrl, parseExternalUrl } from "../externalLinks";
import {
  openLocalFile,
  resolveLocalFileReference,
  resolveWorkspacePath,
  type LocalFileTarget,
} from "../localFiles";
import { normalizeMathDelimiters } from "../markdownMath";

function FileReference(props: {
  children: ReactNode;
  target: LocalFileTarget;
  onOpenFile?: (target: LocalFileTarget) => void;
}) {
  const location = props.target.line ? `:${props.target.line}` : "";

  return (
    <button
      type="button"
      className="file-reference"
      title={`${props.target.path}${location}`}
      onClick={() => props.onOpenFile?.(props.target)}
    >
      <FileText size={15} aria-hidden="true" />
      <span>{props.children}</span>
    </button>
  );
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}

function headingSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{Letter}\p{Number}_-]/gu, "") || "section";
}

function headingComponents() {
  const occurrences = new Map<string, number>();
  const heading = (tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") =>
    ({ node: _node, ...props }: ComponentPropsWithoutRef<"h1"> & { node?: unknown }) => {
      const base = headingSlug(nodeText(props.children));
      const occurrence = occurrences.get(base) ?? 0;
      occurrences.set(base, occurrence + 1);
      const id = occurrence === 0 ? base : `${base}-${occurrence}`;
      return createElement(tag, { ...props, id: props.id ?? id });
    };
  return {
    h1: heading("h1"),
    h2: heading("h2"),
    h3: heading("h3"),
    h4: heading("h4"),
    h5: heading("h5"),
    h6: heading("h6"),
  };
}

function MarkdownLink(
  props: AnchorHTMLAttributes<HTMLAnchorElement> & {
    node?: unknown;
    workspacePath?: string | null;
    referenceBasePath?: string | null;
    onOpenFile?: (target: LocalFileTarget) => void;
    onOpenUrl?: (url: string) => void;
  },
) {
  const {
    node: _node,
    workspacePath,
    referenceBasePath,
    onOpenFile,
    onOpenUrl,
    ...anchorProps
  } = props;
  if (props.href?.startsWith("#")) {
    return <a {...anchorProps} />;
  }
  const resolutionBase = referenceBasePath ?? workspacePath;
  const filePath = props.href
    ? resolveLocalFileReference(props.href, resolutionBase, nodeText(props.children))
    : null;
  if (filePath) {
    const handleFileClick = (event: MouseEvent<HTMLAnchorElement>) => {
      props.onClick?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (onOpenFile) onOpenFile(filePath);
      else void openLocalFile(filePath.path, workspacePath);
    };
    const location = filePath.line ? `:${filePath.line}` : "";
    return (
      <a
        {...anchorProps}
        className="file-reference-link"
        title={`${filePath.path}${location}`}
        onClick={handleFileClick}
      />
    );
  }

  const url = props.href ? parseExternalUrl(props.href) : null;
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    props.onClick?.(event);
    if (event.defaultPrevented) return;

    // Open recognized external URLs in the system browser
    if (url) {
      event.preventDefault();
      if (onOpenUrl && (url.protocol === "http:" || url.protocol === "https:")) {
        onOpenUrl(url.href);
      } else {
        void openExternalUrl(url).catch(() => undefined);
      }
      return;
    }

    // For any non-external href, try to open it as a local file directly
    // in the system default application (not the built-in preview panel).
    if (props.href) {
      event.preventDefault();
      let candidatePath: string | null = null;
      const href = props.href;

      if (/^file:/i.test(href)) {
        try {
          const fileUrl = new URL(href);
          let p = decodeURIComponent(fileUrl.pathname);
          if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
          candidatePath = p;
        } catch { /* ignore */ }
      } else {
        candidatePath = resolveWorkspacePath(href, resolutionBase) ?? href;
      }

      if (candidatePath) {
        if (onOpenFile) onOpenFile({ path: candidatePath, line: null, column: null });
        else void openLocalFile(candidatePath, workspacePath);
      }
      return;
    }

    // Prevent default navigation for any non-external URL to avoid SPA reload
    event.preventDefault();
  };

  return <a {...anchorProps} rel="noreferrer" onClick={handleClick} />;
}

function MarkdownCode(
  props: ComponentPropsWithoutRef<"code"> & {
    node?: unknown;
    workspacePath?: string | null;
    referenceBasePath?: string | null;
    onOpenFile?: (target: LocalFileTarget) => void;
  },
) {
  const {
    children,
    node: _node,
    workspacePath,
    referenceBasePath,
    onOpenFile,
    ...codeProps
  } = props;
  const text = typeof children === "string" ? children : "";
  const filePath = !text.includes("\n")
    ? resolveLocalFileReference(text, referenceBasePath ?? workspacePath)
    : null;
  if (filePath) {
    return (
      <FileReference target={filePath} onOpenFile={onOpenFile}>
        {children}
      </FileReference>
    );
  }
  return <code {...codeProps}>{children}</code>;
}

/** Fenced code block with a hover copy button (ChatGPT-style). */
function MarkdownPre(props: ComponentPropsWithoutRef<"pre"> & { node?: unknown }) {
  const { node: _node, ...preProps } = props;
  const preRef = useRef<HTMLPreElement>(null);
  const resetTimer = useRef<number | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  const copy = async () => {
    const text = preRef.current?.innerText ?? "";
    if (!text) return;
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 1500);
  };

  const copied = copyState === "copied";
  const label = copied ? "已复制" : copyState === "error" ? "复制失败" : "复制";

  return (
    <div className="code-block">
      <button
        type="button"
        className={`code-copy ${copyState !== "idle" ? copyState : ""}`}
        title={copyState === "error" ? "无法访问剪贴板" : "复制代码"}
        onClick={() => void copy()}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {label}
      </button>
      <pre ref={preRef} {...preProps} />
    </div>
  );
}

/**
 * Custom URL transform that allows local file paths (Windows drive letters,
 * Unix absolute paths, relative paths) while keeping react-markdown's default
 * sanitization for web protocols. Without this, react-markdown v10 strips
 * Windows paths like `D:/path` because it treats `D:` as an unknown protocol.
 */
function localFileUrlTransform(value: string): string {
  // Allow Windows drive paths (D:\ or D:/) and UNC paths (\\server\)
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) {
    return value;
  }
  // Allow Unix absolute paths and relative paths (no colon = no protocol)
  if (value.startsWith("/") || value.indexOf(":") === -1) {
    return value;
  }
  // Fall back to react-markdown's default safe-protocol check
  const colon = value.indexOf(":");
  const slash = value.indexOf("/");
  if (slash !== -1 && colon > slash) return value;
  const questionMark = value.indexOf("?");
  if (questionMark !== -1 && colon > questionMark) return value;
  const numberSign = value.indexOf("#");
  if (numberSign !== -1 && colon > numberSign) return value;
  if (/^(https?|ircs?|mailto|xmpp)$/i.test(value.slice(0, colon))) return value;
  return "";
}

/** Markdown renderer for assistant output. */
export function Md(props: {
  children: string;
  workspacePath?: string | null;
  referenceBasePath?: string | null;
  headingAnchors?: boolean;
  onOpenFile?: (target: LocalFileTarget) => void;
  onOpenUrl?: (url: string) => void;
}) {
  const headings = props.headingAnchors ? headingComponents() : {};
  return (
    <div className="md">
      <ReactMarkdown
        urlTransform={localFileUrlTransform}
        components={{
          ...headings,
          a: (linkProps) => (
            <MarkdownLink
              {...linkProps}
              workspacePath={props.workspacePath}
              referenceBasePath={props.referenceBasePath}
              onOpenFile={props.onOpenFile}
              onOpenUrl={props.onOpenUrl}
            />
          ),
          code: (codeProps) => (
            <MarkdownCode
              {...codeProps}
              workspacePath={props.workspacePath}
              referenceBasePath={props.referenceBasePath}
              onOpenFile={props.onOpenFile}
            />
          ),
          pre: MarkdownPre,
        }}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
        remarkPlugins={[remarkGfm, remarkMath]}
      >
        {normalizeMathDelimiters(props.children)}
      </ReactMarkdown>
    </div>
  );
}
