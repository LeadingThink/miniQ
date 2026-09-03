import { describe, expect, it } from "vitest";
import {
  formatFileSize,
  isTextPreviewFile,
  looksLikeFileReference,
  resolveLocalFileReference,
  resolveWorkspacePath,
} from "./localFiles";

describe("local file preview types", () => {
  it.each([
    "src/main.ts",
    "docs/README.md",
    "D:\\work\\app\\.env",
    "/work/app/.env.local",
    "/work/app/config.JSON",
    "/work/app/Dockerfile",
  ])("previews text file %s", (path) => {
    expect(isTextPreviewFile(path)).toBe(true);
  });

  it.each([
    "archive.zip",
    "document.pdf",
    "image.png",
    "report.docx",
    "installer.exe",
  ])("reveals non-text file %s", (path) => {
    expect(isTextPreviewFile(path)).toBe(false);
  });

  it("formats file sizes without noisy precision", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(25 * 1024)).toBe("25 KB");
    expect(formatFileSize(2.25 * 1024 * 1024)).toBe("2.3 MB");
  });
});

describe("local file references", () => {
  it("resolves Windows and POSIX relative paths", () => {
    expect(resolveLocalFileReference("src/main.ts:12:4", "D:\\work\\app")).toEqual({
      path: "D:\\work\\app\\src\\main.ts",
      line: 12,
      column: 4,
    });
    expect(resolveLocalFileReference("docs/README.md#L8", "/work/app")).toEqual({
      path: "/work/app/docs/README.md",
      line: 8,
      column: null,
    });
  });

  it("preserves absolute paths", () => {
    expect(resolveLocalFileReference("D:/work/app/main.ts", "/ignored")?.path).toBe(
      "D:/work/app/main.ts",
    );
    expect(resolveLocalFileReference("/work/app/main.ts", "D:/ignored")?.path).toBe(
      "/work/app/main.ts",
    );
  });

  it("uses a Markdown label as the line-location fallback", () => {
    expect(
      resolveLocalFileReference(
        "src/worker.py",
        "/work/app",
        "worker.py (line 130)",
      ),
    ).toEqual({ path: "/work/app/src/worker.py", line: 130, column: null });
  });

  it("resolves artifact paths without relying on their extension", () => {
    expect(resolveWorkspacePath("output/result.patch", "/work/app")).toBe(
      "/work/app/output/result.patch",
    );
  });

  it("rejects URLs and ordinary code", () => {
    expect(looksLikeFileReference("https://example.com/file.ts")).toBe(false);
    expect(looksLikeFileReference("npm test")).toBe(false);
    expect(resolveLocalFileReference("answer.value", "/work/app")).toBe(null);
  });

  it("rejects shortened paths that do not identify a real file", () => {
    expect(looksLikeFileReference(String.raw`storage\uploads\...\TEST.zip`)).toBe(false);
    expect(resolveLocalFileReference("storage/…/TEST.zip", "/work/app")).toBe(null);
  });
});
