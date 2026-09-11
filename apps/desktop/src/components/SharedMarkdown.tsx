import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { normalizeMathDelimiters } from "../markdownMath";
import type { SharedFile } from "../sharing";

// Public documents never invoke desktop file handlers or load arbitrary image URLs.
export function SharedMarkdown({ children, files = [], onFile }: {
  children: string; files?: SharedFile[]; onFile?: (file: SharedFile) => void;
}) {
  const file = (value?: string) => files.find((file) => value === `miniq-file:${file.id}`);
  return <div className="md"><ReactMarkdown
    urlTransform={(value) => file(value) || /^https?:\/\//i.test(value) ? value : ""}
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[[rehypeKatex, { strict: false, throwOnError: false, trust: false }]]}
    components={{
      a: ({ href, children }) => {
        const target = file(href);
        return target ? <button type="button" className="shared-file-link" onClick={() => onFile?.(target)}>{children}</button>
          : href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
      },
      img: ({ src, alt }) => {
        const target = file(src);
        return target ? <button type="button" className="shared-file-link" onClick={() => onFile?.(target)}>{alt || target.name} · 查看文件</button>
          : <span className="shared-unavailable">{alt || "图片"}（未随链接分享）</span>;
      },
      pre: (props) => <MarkdownCodeBlock {...props} diagrams />,
    }}
  >{normalizeMathDelimiters(children)}</ReactMarkdown></div>;
}
