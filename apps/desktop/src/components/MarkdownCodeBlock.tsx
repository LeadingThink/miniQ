import {
  isValidElement,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { WrapText } from "lucide-react";
import { CopyButton } from "./CopyButton";
import { MermaidPreview } from "./MermaidPreview";
import "./MarkdownCodeBlock.css";

function codeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(codeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node))
    return codeText(node.props.children);
  return "";
}

export function MarkdownCodeBlock(
  props: ComponentPropsWithoutRef<"pre"> & {
    node?: unknown;
    diagrams?: boolean;
  },
) {
  const { node: _node, diagrams, children, ...preProps } = props;
  const [wrap, setWrap] = useState(false);
  const language = isValidElement<{ className?: string }>(children)
    ? /(?:^|\s)language-([^\s]+)/.exec(children.props.className ?? "")?.[1]
    : undefined;
  const text = codeText(children);
  if (diagrams && language === "mermaid")
    return <MermaidPreview source={text} />;
  return (
    <div className="code-block" data-wrap={wrap}>
      <div className="code-block-toolbar">
        <span>{language ?? "代码"}</span>
        <button
          type="button"
          className="icon-button"
          aria-label="代码自动换行"
          title="代码自动换行"
          aria-pressed={wrap}
          onClick={() => setWrap((value) => !value)}
        >
          <WrapText size={14} />
        </button>
        <CopyButton
          content={text}
          label="复制代码"
          className="icon-button code-copy-button"
        />
      </div>
      <pre {...preProps}>{children}</pre>
    </div>
  );
}
