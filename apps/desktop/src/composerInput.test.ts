import { describe, expect, it } from "vitest";
import {
  canSendComposer,
  isComposerSendKey,
  shouldShowComposerSend,
} from "./composerInput";

describe("composer input behavior", () => {
  it("allows attachments to be sent without filler text", () => {
    expect(canSendComposer("", ["/tmp/report.pdf"])).toBe(true);
  });

  it("does not submit during IME composition or on Shift+Enter", () => {
    expect(isComposerSendKey("Enter", false, false)).toBe(true);
    expect(isComposerSendKey("Enter", true, false)).toBe(false);
    expect(isComposerSendKey("Enter", false, true)).toBe(false);
  });

  it("hides the queue button while busy until there is content to queue", () => {
    expect(shouldShowComposerSend(true, "", [])).toBe(false);
    expect(shouldShowComposerSend(true, "next task", [])).toBe(true);
    expect(shouldShowComposerSend(true, "", ["/tmp/report.pdf"])).toBe(true);
    expect(shouldShowComposerSend(false, "", [])).toBe(true);
  });
});
