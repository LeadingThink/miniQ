// @vitest-environment jsdom
import { expect, it } from "vitest";
import { LARGE_PASTE_CHARS, charCount, draftSegments, expandPastes, isLargePaste, nextPlaceholder } from "./largePaste";

it("collapses only pastes above the threshold", () => {
  expect(isLargePaste("短文本")).toBe(false);
  expect(isLargePaste("字".repeat(LARGE_PASTE_CHARS))).toBe(false);
  expect(isLargePaste("字".repeat(LARGE_PASTE_CHARS + 1))).toBe(true);
});

it("counts characters rather than UTF-16 units", () => {
  expect(charCount("😀")).toBe(1);
  expect(isLargePaste("😀".repeat(LARGE_PASTE_CHARS + 1))).toBe(true);
});

it("labels a paste with its size and keeps repeated sizes apart", () => {
  const first = nextPlaceholder("字".repeat(4200), []);
  expect(first).toBe("[粘贴内容 4200 字]");
  expect(nextPlaceholder("字".repeat(4200), [first])).toBe("[粘贴内容 4200 字 #2]");
  expect(nextPlaceholder("字".repeat(4200), [first, "[粘贴内容 4200 字 #2]"])).toBe("[粘贴内容 4200 字 #3]");
});

it("expands every placeholder back into the full text", () => {
  const pastes = [
    { placeholder: "[粘贴内容 3 字]", text: "abc" },
    { placeholder: "[粘贴内容 2 字]", text: "de" },
  ];
  expect(expandPastes("前 [粘贴内容 3 字] 后 [粘贴内容 2 字]", pastes)).toBe("前 abc 后 de");
  expect(expandPastes("没有占位符", pastes)).toBe("没有占位符");
});

it("splits a draft into text and one chip per paste", () => {
  const pastes = [
    { placeholder: "[粘贴内容 3 字]", text: "abc" },
    { placeholder: "[粘贴内容 2 字]", text: "de" },
  ];
  expect(draftSegments("前[粘贴内容 3 字]后[粘贴内容 2 字]", pastes)).toEqual([
    { kind: "text", text: "前" },
    { kind: "paste", paste: pastes[0] },
    { kind: "text", text: "后" },
    { kind: "paste", paste: pastes[1] },
    { kind: "text", text: "" },
  ]);
  expect(draftSegments("没有占位符", pastes)).toEqual([{ kind: "text", text: "没有占位符" }]);
});
