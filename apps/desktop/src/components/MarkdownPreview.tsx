import type { LocalFileTarget } from "../localFiles";
import { Md } from "./Md";
import { Code2, List } from "lucide-react";
import { useMemo } from "react";
import { usePreviewScroll, usePreviewValue } from "../previewViewState";
import { markdownOutline } from "../markdownOutline";

export function MarkdownPreview(props: {
  content: string;
  workspacePath: string;
  currentFilePath: string;
  onOpenFile: (target: LocalFileTarget) => void;
}) {
  const scroll = usePreviewScroll<HTMLElement>("markdown");
  const rootRef = scroll.ref;
  const [outlineOpen, setOutlineOpen] = usePreviewValue(
    "markdownOutline",
    false,
  );
  const headings = useMemo(
    () => markdownOutline(props.content),
    [props.content],
  );
  const jump = (id: string) => {
    const target = Array.from(
      rootRef.current?.querySelectorAll<HTMLElement>(".md [id]") ?? [],
    ).find((element) => element.id === id);
    target?.scrollIntoView({ block: "start" });
  };
  if (!props.content.trim()) {
    return <div className="diff-empty">Markdown 文件为空</div>;
  }

  const lastSeparator = Math.max(
    props.currentFilePath.lastIndexOf("/"),
    props.currentFilePath.lastIndexOf("\\"),
  );
  const referenceBasePath =
    lastSeparator >= 0
      ? props.currentFilePath.slice(0, lastSeparator)
      : props.workspacePath;

  return (
    <article
      {...scroll}
      className="markdown-preview"
      aria-label="Markdown 预览"
      onClick={(event) => {
        const anchor = (event.target as Element).closest("a[href^='#']");
        if (!anchor) return;
        event.preventDefault();
        const hash = anchor.getAttribute("href")?.slice(1) ?? "";
        try {
          jump(decodeURIComponent(hash));
        } catch {
          jump(hash);
        }
      }}
    >
      {headings.length > 0 && (
        <details
          className="markdown-outline"
          open={outlineOpen}
          onToggle={(event) => setOutlineOpen(event.currentTarget.open)}
        >
          <summary>
            <List size={15} />
            目录 · {headings.length}
          </summary>
          <nav aria-label="文档目录">
            {headings.map((heading) => (
              <div
                key={heading.id}
                style={{ paddingLeft: (heading.depth - 1) * 10 }}
              >
                <button
                  type="button"
                  className="outline-heading"
                  onClick={() => jump(heading.id)}
                >
                  {heading.text}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title={`查看第 ${heading.line} 行源码`}
                  aria-label={`查看 ${heading.text} 的源码`}
                  onClick={() =>
                    props.onOpenFile({
                      path: props.currentFilePath,
                      line: heading.line,
                      column: 1,
                    })
                  }
                >
                  <Code2 size={13} />
                </button>
              </div>
            ))}
          </nav>
        </details>
      )}
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
