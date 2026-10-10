import { describe, expect, it } from "vitest";
import { MAX_REPLY_FILES, replyFileArtifacts } from "./replyFiles";

const message = (content: string) => ({
  id: "msg_1",
  sessionId: "sess_1",
  content,
  createdAt: "2026-10-10T08:42:57Z",
});

describe("replyFileArtifacts", () => {
  it("turns a linked PDF written by a shell script into a file card", () => {
    const files = replyFileArtifacts(
      message(
        "已合成完成，共 3 页。\n\n[下载合成 PDF](</Users/me/showee/tmp/pdfs/个人所得税纳税记录_合成.pdf>)",
      ),
      "/Users/me/showee",
    );
    expect(files).toEqual([
      expect.objectContaining({
        path: "/Users/me/showee/tmp/pdfs/个人所得税纳税记录_合成.pdf",
        title: "个人所得税纳税记录_合成.pdf",
        kind: "PDF",
      }),
    ]);
  });

  it("resolves relative and percent-encoded links against the workspace", () => {
    const files = replyFileArtifacts(
      message("[报告](out/a%20b.docx) 和 [表格](./data.xlsx)"),
      "/w",
    );
    expect(files.map((file) => [file.path, file.kind])).toEqual([
      ["/w/out/a b.docx", "Word"],
      ["/w/data.xlsx", "Excel"],
    ]);
  });

  it("skips source files, web links, code blocks and duplicates", () => {
    const files = replyFileArtifacts(
      message(
        [
          "[脚本](/w/run.py) [网页](https://example.com/a.pdf)",
          "```\n[代码里](/w/inside.pdf)\n```",
          "`[行内](/w/inline.pdf)`",
          "[一](/w/a.pdf) [二](/w/a.pdf)",
        ].join("\n"),
      ),
      "/w",
    );
    expect(files.map((file) => file.path)).toEqual(["/w/a.pdf"]);
  });

  it("skips files the daemon already shows as artifacts", () => {
    const files = replyFileArtifacts(message("[图](/w/a.png)"), "/w", new Set(["/w/a.png"]));
    expect(files).toEqual([]);
  });

  it("caps the number of cards per reply", () => {
    const links = Array.from({ length: 10 }, (_, index) => `[f${index}](/w/f${index}.pdf)`).join(" ");
    expect(replyFileArtifacts(message(links), "/w")).toHaveLength(MAX_REPLY_FILES);
  });
});
