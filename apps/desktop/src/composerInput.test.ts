import { describe, expect, it } from "vitest";
import {
  canSendComposer,
  shouldShowComposerSend,
} from "./composerInput";

describe("composer input behavior", () => {
  it("allows attachments to be sent without filler text", () => {
    expect(canSendComposer("", ["/tmp/report.pdf"])).toBe(true);
  });

  it("hides the queue button while busy until there is content to queue", () => {
    expect(shouldShowComposerSend(true, "", [])).toBe(false);
    expect(shouldShowComposerSend(true, "next task", [])).toBe(true);
    expect(shouldShowComposerSend(true, "", ["/tmp/report.pdf"])).toBe(true);
    expect(shouldShowComposerSend(false, "", [])).toBe(true);
  });
});
