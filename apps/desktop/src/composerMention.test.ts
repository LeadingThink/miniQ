import { describe, expect, it } from "vitest";
import {
  applyMention,
  filterMentionFiles,
  formatMention,
  insertComposerText,
  mentionToken,
  quoteMarkdown,
} from "./composerMention";

describe("mentionToken", () => {
  it("detects @ at the start or after whitespace", () => {
    expect(mentionToken("@src", 4)).toEqual({ start: 0, end: 4, query: "src" });
    expect(mentionToken("看看 @ap", 6)).toEqual({ start: 3, end: 6, query: "ap" });
    expect(mentionToken("第一行\n@", 5)).toEqual({ start: 4, end: 5, query: "" });
  });

  it("ignores e-mail style @ and finished tokens", () => {
    expect(mentionToken("a@b", 3)).toBeNull();
    expect(mentionToken("@src done", 9)).toBeNull();
    expect(mentionToken("plain", 5)).toBeNull();
    expect(mentionToken("@x", -1)).toBeNull();
  });

  it("extends the token past the caret", () => {
    expect(mentionToken("@srcfile rest", 2)).toEqual({ start: 0, end: 8, query: "s" });
  });
});

describe("applyMention", () => {
  it("replaces the token and adds one trailing space", () => {
    expect(applyMention("看 @ap", { start: 2, end: 5 }, "src/App.tsx")).toEqual({
      value: "看 @src/App.tsx ",
      cursor: 15,
    });
    expect(applyMention("@a 后文", { start: 0, end: 2 }, "a.md")).toEqual({
      value: "@a.md 后文",
      cursor: 6,
    });
  });

  it("wraps paths with spaces in backticks", () => {
    expect(formatMention("docs/a b.md")).toBe("@`docs/a b.md`");
    expect(applyMention("@a", { start: 0, end: 2 }, "a b.md").value).toBe("@`a b.md` ");
  });
});

describe("filterMentionFiles", () => {
  const files = [
    { path: "src/", directory: true },
    { path: "src/components/App.tsx", directory: false },
    { path: "src/app.ts", directory: false },
    { path: "README.md", directory: false },
    { path: "docs/apple/notes.md", directory: false },
  ];

  it("lists shallow paths first for an empty query and honours the limit", () => {
    expect(filterMentionFiles(files, "", 2).map((f) => f.path)).toEqual(["README.md", "src/"]);
  });

  it("fuzzy matches and drops non-matches", () => {
    const result = filterMentionFiles(files, "app").map((f) => f.path);
    expect(result).toContain("src/app.ts");
    expect(result).toContain("src/components/App.tsx");
    expect(result).not.toContain("README.md");
    expect(filterMentionFiles(files, "zzz")).toEqual([]);
  });
});

describe("insertComposerText", () => {
  it("inserts at a selection", () => {
    expect(insertComposerText("甲乙丙", "X", { start: 1, end: 2 })).toEqual({ value: "甲X丙", cursor: 2 });
  });

  it("appends with the right separator", () => {
    expect(insertComposerText("", "hi", null)).toEqual({ value: "hi", cursor: 2 });
    expect(insertComposerText("a", "b", null).value).toBe("a b");
    expect(insertComposerText("a", "> q\n\n", null).value).toBe("a\n\n> q\n\n");
    expect(insertComposerText("a ", "b", null).value).toBe("a b");
  });
});

describe("quoteMarkdown", () => {
  it("prefixes every line and ends with a blank line", () => {
    expect(quoteMarkdown("第一行\r\n第二行\n")).toBe("> 第一行\n> 第二行\n\n");
  });
});
