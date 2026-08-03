import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionDiff } from "../types";
import { ReviewPanel } from "./ReviewPanel";

const DIFF: SessionDiff = {
  additions: 1,
  deletions: 1,
  files: [
    {
      path: "src/main.ts",
      absolutePath: "D:/work/app/src/main.ts",
      oldExists: true,
      newExists: true,
      binary: false,
      additions: 1,
      deletions: 1,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            { kind: "deletion", oldLine: 1, newLine: null, content: "old" },
            { kind: "addition", oldLine: null, newLine: 1, content: "new" },
          ],
        },
      ],
    },
  ],
};

describe("ReviewPanel", () => {
  it("renders changed files, stats, line numbers, and diff content", () => {
    const html = renderToStaticMarkup(
      <ReviewPanel diff={DIFF} onOpenFile={() => undefined} onClose={() => undefined} />,
    );

    expect(html).toContain("src/main.ts");
    expect(html).toContain("+1");
    expect(html).toContain("-1");
    expect(html).toContain("old");
    expect(html).toContain("new");
  });
});
