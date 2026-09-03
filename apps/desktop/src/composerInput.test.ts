import { describe, expect, it } from "vitest";
import {
  buildComposerMessage,
  canSendComposer,
  isComposerSendKey,
} from "./composerInput";

describe("composer input behavior", () => {
  it("allows attachments to be sent without filler text", () => {
    expect(canSendComposer("", ["/tmp/report.pdf"])).toBe(true);
    expect(buildComposerMessage("", ["/tmp/report.pdf"])).toEqual({
      content: "[用户附加的本地文件]\n- /tmp/report.pdf",
      images: [],
    });
  });

  it("combines trimmed text and every attachment", () => {
    expect(
      buildComposerMessage("  review this  ", ["/tmp/a.pdf", "/tmp/b.docx"]),
    ).toEqual({
      content: "review this\n\n[用户附加的本地文件]\n- /tmp/a.pdf\n- /tmp/b.docx",
      images: [],
    });
  });

  it("preserves pasted images alongside text and local files", () => {
    const images = [{ mediaType: "image/png", data: "aGVsbG8=" }];
    expect(canSendComposer("", [], images)).toBe(true);
    expect(buildComposerMessage("look", [], images)).toEqual({
      content: "look",
      images,
    });
  });

  it("does not submit during IME composition or on Shift+Enter", () => {
    expect(isComposerSendKey("Enter", false, false)).toBe(true);
    expect(isComposerSendKey("Enter", true, false)).toBe(false);
    expect(isComposerSendKey("Enter", false, true)).toBe(false);
  });
});
