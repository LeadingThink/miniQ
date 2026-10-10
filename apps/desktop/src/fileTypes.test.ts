import { describe, expect, it } from "vitest";
import { deliverableFileType, fileTypeInfo } from "./fileTypes";

describe("fileTypeInfo", () => {
  it.each([
    ["/w/report.pdf", "pdf", "PDF"],
    ["/w/方案.DOCX", "word", "Word"],
    ["/w/data.xlsx", "excel", "Excel"],
    ["/w/data.csv", "excel", "CSV"],
    ["/w/deck.pptx", "ppt", "PPT"],
    ["/w/shot.png", "image", "图片"],
    ["/w/voice.m4a", "audio", "音频"],
    ["/w/demo.mp4", "video", "视频"],
    ["/w/bundle.zip", "archive", "压缩包"],
    ["/w/notes.md", "markdown", "Markdown"],
    ["/w/page.html", "html", "HTML"],
  ])("maps %s to %s", (path, type, label) => {
    expect(fileTypeInfo(path)).toEqual({ type, label });
  });

  it("uses the reported kind when the path has no known extension", () => {
    expect(fileTypeInfo("/w/generated", "image")).toEqual({ type: "image", label: "图片" });
    expect(fileTypeInfo("/w/generated", "docx")).toEqual({ type: "word", label: "Word" });
    expect(fileTypeInfo("/w/blob", "media")).toEqual({ type: "other", label: "media" });
    expect(fileTypeInfo("/w/blob")).toEqual({ type: "other", label: "文件" });
  });

  it("does not treat source code as a deliverable", () => {
    expect(deliverableFileType("/w/main.py")).toBeNull();
    expect(deliverableFileType("/w/a.pdf?x=1")).toEqual({ type: "pdf", label: "PDF" });
  });
});
