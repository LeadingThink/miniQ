import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";

describe("MarkdownPreview", () => {
  it("renders Markdown structure instead of source text", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview
        content={"# Report\n\n- complete"}
        workspacePath="/work/project"
        currentFilePath="/work/project/README.md"
        onOpenFile={() => undefined}
      />,
    );

    expect(html).toContain("<h1");
    expect(html).toContain("<li>complete</li>");
    expect(html).not.toContain("# Report");
  });

  it("shows a clear empty-file state", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview
        content={" \n"}
        workspacePath="/work"
        currentFilePath="/work/README.md"
        onOpenFile={() => undefined}
      />,
    );

    expect(html).toContain("Markdown 文件为空");
  });

  it("resolves relative links from the Markdown file directory", () => {
    const html = renderToStaticMarkup(
      <MarkdownPreview
        content={"[Details](details.md)"}
        workspacePath="/work/project"
        currentFilePath="/work/project/docs/guide.md"
        onOpenFile={() => undefined}
      />,
    );

    expect(html).toContain("/work/project/docs/details.md");
  });
});
