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
  resolveLocalFileReference,
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
    return (
      <FileReference target={filePath} onOpenFile={onOpenFile}>
        {props.children}
      </FileReference>
    );
  }

  const url = props.href ? parseExternalUrl(props.href) : null;
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    props.onClick?.(event);
    if (event.defaultPrevented || !url) return;
    event.preventDefault();
    void openExternalUrl(url).catch(() => undefined);
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

/** Markdown renderer for assistant output. */
export function Md(props: {
  children: string;
  workspacePath?: string | null;
  onOpenFile?: (target: LocalFileTarget) => void;
}) {
  return (
    <div className="md">
      <ReactMarkdown
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
