import { FileText } from "lucide-react";
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
  return "";
}

function MarkdownLink(
  props: AnchorHTMLAttributes<HTMLAnchorElement> & {
    node?: unknown;
    workspacePath?: string | null;
    onOpenFile?: (target: LocalFileTarget) => void;
  },
) {
  const { node: _node, workspacePath, onOpenFile, ...anchorProps } = props;
  const filePath = props.href
    ? resolveLocalFileReference(props.href, workspacePath, nodeText(props.children))
    : null;
  if (filePath) {
    const handleFileClick = (event: MouseEvent<HTMLAnchorElement>) => {
      props.onClick?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      openLocalFile(filePath.path, workspacePath).catch(() => {
        onOpenFile?.(filePath);
      });
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
      void openExternalUrl(url).catch(() => undefined);
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
        // Resolve relative paths against workspacePath to get absolute paths
        candidatePath = resolveWorkspacePath(href, workspacePath) ?? href;
      }

      if (candidatePath) {
        // Try opening with the system default application first
        openLocalFile(candidatePath, workspacePath).catch(() => {
          // Fall back to onOpenFile (preview panel / reveal in explorer)
          onOpenFile?.({ path: candidatePath!, line: null, column: null });
        });
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
    onOpenFile?: (target: LocalFileTarget) => void;
  },
) {
  const { children, node: _node, workspacePath, onOpenFile, ...codeProps } = props;
  const text = typeof children === "string" ? children : "";
  const filePath = !text.includes("\n")
    ? resolveLocalFileReference(text, workspacePath)
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
  onOpenFile?: (target: LocalFileTarget) => void;
}) {
  return (
    <div className="md">
      <ReactMarkdown
        urlTransform={localFileUrlTransform}
        components={{
          a: (linkProps) => (
            <MarkdownLink
              {...linkProps}
              workspacePath={props.workspacePath}
              onOpenFile={props.onOpenFile}
            />
          ),
          code: (codeProps) => (
            <MarkdownCode
              {...codeProps}
              workspacePath={props.workspacePath}
              onOpenFile={props.onOpenFile}
            />
          ),
        }}
        rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false }]]}
        remarkPlugins={[remarkGfm, remarkMath]}
      >
        {normalizeMathDelimiters(props.children)}
      </ReactMarkdown>
    </div>
  );
}
