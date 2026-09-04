import type { LocalFileTarget } from "../localFiles";
import { Md } from "./Md";

export function MarkdownPreview(props: {
  content: string;
  workspacePath: string;
  currentFilePath: string;
  onOpenFile: (target: LocalFileTarget) => void;
}) {
  if (!props.content.trim()) {
    return <div className="diff-empty">Markdown 文件为空</div>;
  }

  const lastSeparator = Math.max(
    props.currentFilePath.lastIndexOf("/"),
    props.currentFilePath.lastIndexOf("\\"),
  );
  const referenceBasePath = lastSeparator >= 0
    ? props.currentFilePath.slice(0, lastSeparator)
    : props.workspacePath;

  return (
    <article className="markdown-preview" aria-label="Markdown 预览">
      <Md
        workspacePath={props.workspacePath}
        referenceBasePath={referenceBasePath}
        headingAnchors
        onOpenFile={props.onOpenFile}
      >
        {props.content}
      </Md>
    </article>
  );
}
