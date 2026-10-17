import { expect, it } from "vitest";
import { markdownFileLinks } from "./markdownFileLinks";

it("uses Markdown syntax for balanced paths and reference links", () => {
  expect(markdownFileLinks('`[方案](/w/计划(新版).pdf)`\n\n[附件][report]\n\n[report]: /w/report.docx')).toEqual([
    "/w/计划(新版).pdf",
    "/w/report.docx",
  ]);
});

it("does not collect fenced examples, commands, images or unsafe schemes", () => {
  expect(markdownFileLinks([
    '~~~md\n`[示例](/w/a.pdf)`\n~~~',
    '```md\n[示例](/w/b.pdf)\n```',
    '`echo [示例](/w/c.pdf)`',
    '`[外链](https://example.com/a.pdf)`',
    '`[危险](javascript:alert(1))`',
    '![附图](/w/d.png)',
  ].join('\n\n'))).toEqual([]);
});

it("keeps Windows paths and source line suffixes", () => {
  expect(markdownFileLinks('`[数据](D:/work/data.xlsx)`\n`[代码](/w/a.ts:42)`')).toEqual([
    "D:/work/data.xlsx", "/w/a.ts:42",
  ]);
});
