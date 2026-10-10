import { describe, expect, it } from "vitest";
import { splitMarkdownBlocks } from "./markdownBlocks";

describe("splitMarkdownBlocks", () => {
  it("splits top-level blocks at blank lines and reproduces the input exactly", () => {
    const text = "# 标题\n\n第一段\n第二行\n\n- a\n- b\n\n结尾";
    const blocks = splitMarkdownBlocks(text);
    expect(blocks).toEqual(["# 标题\n\n", "第一段\n第二行\n\n", "- a\n- b\n\n", "结尾"]);
    expect(blocks.join("")).toBe(text);
  });

  it("keeps fenced code and display math with blank lines in one block", () => {
    const text = "前文\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n$$\nx\n\ny\n$$\n\n后文";
    expect(splitMarkdownBlocks(text)).toEqual([
      "前文\n\n",
      "```ts\nconst a = 1;\n\nconst b = 2;\n```\n\n",
      "$$\nx\n\ny\n$$\n\n",
      "后文",
    ]);
  });

  it("treats an unclosed fence as the open tail", () => {
    const blocks = splitMarkdownBlocks("段落\n\n```\ncode\n\nmore");
    expect(blocks).toEqual(["段落\n\n", "```\ncode\n\nmore"]);
  });

  it("does not split list items or indented continuations apart", () => {
    const text = "1. 第一项\n\n2. 第二项\n\n   续行\n\n    缩进代码\n\n下一段";
    expect(splitMarkdownBlocks(text)).toEqual([
      "1. 第一项\n\n2. 第二项\n\n   续行\n\n    缩进代码\n\n",
      "下一段",
    ]);
  });

  it("keeps completed blocks identical while the tail grows", () => {
    const first = splitMarkdownBlocks("甲\n\n乙");
    const second = splitMarkdownBlocks("甲\n\n乙丙\n\n");
    const third = splitMarkdownBlocks("甲\n\n乙丙\n\n丁");
    expect(second[0]).toBe(first[0]);
    expect(third.slice(0, 2)).toEqual(["甲\n\n", "乙丙\n\n"]);
    expect(splitMarkdownBlocks("")).toEqual([""]);
  });
});
