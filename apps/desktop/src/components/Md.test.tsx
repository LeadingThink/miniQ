import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Md } from "./Md";

function render(markdown: string) {
  return renderToStaticMarkup(<Md>{markdown}</Md>);
}

describe("Md math rendering", () => {
  it("renders Codex-style inline and display delimiters", () => {
    const html = render(String.raw`行内 \(P(A)\)。

\[\binom{104}{26}\]`);

    expect(html.match(/class="katex"/g)).toHaveLength(2);
    expect(html).toContain('class="katex-display"');
  });

  it("renders dollar-delimited math", () => {
    const html = render("Inline $x^2$\n\n$$y^2$$");

    expect(html.match(/class="katex"/g)).toHaveLength(2);
    expect(html).toContain('class="katex-display"');
  });

  it("leaves math delimiters inside code untouched", () => {
    const html = render("Code: `\\(x\\)`\n\n```text\n\\[y\\]\n```");

    expect(html).not.toContain('class="katex"');
    expect(html).toContain("\\(x\\)");
    expect(html).toContain("\\[y\\]");
  });
});

describe("Md file references", () => {
  it("turns inline code paths into workspace file controls", () => {
    const html = renderToStaticMarkup(
      <Md workspacePath="D:/work/project">
        {"Generated `novel_8352189/download.py`."}
      </Md>,
    );

    expect(html).toContain('class="file-reference"');
    expect(html).toContain("D:/work/project/novel_8352189/download.py");
  });

  it("renders Markdown file links as file controls", () => {
    const html = renderToStaticMarkup(
      <Md workspacePath="/work/project">{"[README.md](docs/README.md)"}</Md>,
    );

    expect(html).toContain('class="file-reference"');
    expect(html).toContain("/work/project/docs/README.md");
  });

  it("keeps Codex-style line locations on file controls", () => {
    const html = renderToStaticMarkup(
      <Md workspacePath="/work/project">
        {"[worker.py (line 130)](src/worker.py)"}
      </Md>,
    );

    expect(html).toContain("/work/project/src/worker.py:130");
  });

  it("resolves percent-encoded Windows link destinations to absolute paths", () => {
    const html = renderToStaticMarkup(
      <Md workspacePath={"D:\\work\\project"}>
        {String.raw`[data](backend\mongo-dump\alerts.json)`}
      </Md>,
    );

    expect(html).toContain('class="file-reference"');
    expect(html).toContain("D:\\work\\project\\backend\\mongo-dump\\alerts.json");
  });

  it("keeps ordinary inline code as code", () => {
    const html = render("Run `npm test`.");

    expect(html).toContain("<code>npm test</code>");
    expect(html).not.toContain('class="file-reference"');
  });
});
