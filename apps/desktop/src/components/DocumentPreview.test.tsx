import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PdfPreview } from "./DocumentPreview";

describe("PdfPreview", () => {
  it("renders accessible page and zoom controls before parsing completes", () => {
    const html = renderToStaticMarkup(
      <PdfPreview dataBase64="" onError={() => undefined} />,
    );
    expect(html).toContain('aria-label="上一页"');
    expect(html).toContain('aria-label="下一页"');
    expect(html).toContain('aria-label="缩小 PDF"');
    expect(html).toContain('aria-label="放大 PDF"');
    expect(html).toContain("正在渲染第 1 页");
  });
});
