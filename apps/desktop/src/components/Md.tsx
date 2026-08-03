import { FileText } from "lucide-react";
import { useState } from "react";
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
import { openLocalFile, resolveLocalFileReference } from "../localFiles";
import { normalizeMathDelimiters } from "../markdownMath";

function FileReference(props: { children: ReactNode; path: string }) {
  const [failed, setFailed] = useState(false);
  const open = async () => {
    setFailed(false);
    try {
      await openLocalFile(props.path);
    } catch {
      setFailed(true);
    }
  };

  return (
    <button
      type="button"
      className={`file-reference${failed ? " failed" : ""}`}
      title={failed ? "无法打开此文件,请确认文件仍然存在" : props.path}
      onClick={() => void open()}
    >
      <FileText size={15} aria-hidden="true" />
      <span>{props.children}</span>
    </button>
  );
}

function MarkdownLink(
  props: AnchorHTMLAttributes<HTMLAnchorElement> & {
    node?: unknown;
    workspacePath?: string | null;
  },
) {
  const { node: _node, workspacePath, ...anchorProps } = props;
  const filePath = props.href
    ? resolveLocalFileReference(props.href, workspacePath)
    : null;
  if (filePath) {
    return <FileReference path={filePath}>{props.children}</FileReference>;
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
  },
) {
  const { children, node: _node, workspacePath, ...codeProps } = props;
  const text = typeof children === "string" ? children : "";
  const filePath = !text.includes("\n")
    ? resolveLocalFileReference(text, workspacePath)
    : null;
  if (filePath) return <FileReference path={filePath}>{children}</FileReference>;
  return <code {...codeProps}>{children}</code>;
}

/** Markdown renderer for assistant output. */
export function Md(props: { children: string; workspacePath?: string | null }) {
  return (
    <div className="md">
      <ReactMarkdown
        components={{
          a: (linkProps) => (
            <MarkdownLink {...linkProps} workspacePath={props.workspacePath} />
          ),
          code: (codeProps) => (
            <MarkdownCode {...codeProps} workspacePath={props.workspacePath} />
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
