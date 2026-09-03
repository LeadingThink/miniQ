import { describe, expect, it } from "vitest";
import {
  buildComposerMessage,
  canSendComposer,
  isComposerSendKey,
} from "./composerInput";

describe("composer input behavior", () => {
  it("allows attachments to be sent without filler text", () => {
    expect(canSendComposer("", ["/tmp/report.pdf"])).toBe(true);
    expect(buildComposerMessage("", ["/tmp/report.pdf"])).toBe(
      "[用户附加的本地文件]\n- /tmp/report.pdf",
    );
  });

  it("combines trimmed text and every attachment", () => {
    expect(
      buildComposerMessage("  review this  ", ["/tmp/a.pdf", "/tmp/b.docx"]),
    ).toBe(
      "review this\n\n[用户附加的本地文件]\n- /tmp/a.pdf\n- /tmp/b.docx",
    );
  });

  it("does not submit during IME composition or on Shift+Enter", () => {
    expect(isComposerSendKey("Enter", false, false)).toBe(true);
    expect(isComposerSendKey("Enter", true, false)).toBe(false);
    expect(isComposerSendKey("Enter", false, true)).toBe(false);
  });
});
