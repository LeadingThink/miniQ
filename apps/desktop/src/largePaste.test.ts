// @vitest-environment jsdom
import { expect, it } from "vitest";
import {
  LARGE_PASTE_CHARS, charCount, draftSegments, expandPastes, isLargePaste,
  sentMessageSegments,
} from "./largePaste";

it("collapses only pastes above the threshold", () => {
  expect(isLargePaste("短文本")).toBe(false);
  expect(isLargePaste("字".repeat(LARGE_PASTE_CHARS))).toBe(false);
  expect(isLargePaste("字".repeat(LARGE_PASTE_CHARS + 1))).toBe(true);
});

it("counts characters rather than UTF-16 units", () => {
  expect(charCount("😀")).toBe(1);
  expect(isLargePaste("😀".repeat(LARGE_PASTE_CHARS + 1))).toBe(true);
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

it("preserves literal placeholder text inside edited pastes without recursively expanding it", () => {
  const pastes = [
    { placeholder: "[粘贴内容 3 字]", text: "保留 [粘贴内容 2 字] 原样" },
    { placeholder: "[粘贴内容 2 字]", text: "de" },
  ];
  expect(expandPastes("[粘贴内容 3 字]\n[粘贴内容 2 字]", pastes))
    .toBe("保留 [粘贴内容 2 字] 原样\nde");
});

it("keeps the full pasted document together and separates its trailing instruction", () => {
  const paste = "正文".repeat(600);
  expect(sentMessageSegments(`背景说明\n${paste}\n请简要概况该文本内容。`)).toEqual([
    { kind: "paste", text: `背景说明\n${paste}`, label: "粘贴内容 1205 字" },
    { kind: "text", text: "请简要概况该文本内容。" },
  ]);
});

it("keeps short and ambiguous long messages as plain text", () => {
  expect(sentMessageSegments("普通问题")).toEqual([{ kind: "text", text: "普通问题" }]);
  const prose = "没有可辨识换行边界的正文".repeat(100);
  expect(sentMessageSegments(prose)).toEqual([{ kind: "text", text: prose }]);
});
