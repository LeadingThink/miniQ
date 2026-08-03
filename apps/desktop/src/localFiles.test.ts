import { describe, expect, it } from "vitest";
import {
  looksLikeFileReference,
  resolveLocalFileReference,
  resolveWorkspacePath,
} from "./localFiles";

describe("local file references", () => {
  it("resolves Windows and POSIX relative paths", () => {
    expect(resolveLocalFileReference("src/main.ts:12", "D:\\work\\app")).toBe(
      "D:\\work\\app\\src\\main.ts",
    );
    expect(resolveLocalFileReference("docs/README.md#L8", "/work/app")).toBe(
      "/work/app/docs/README.md",
    );
  });

  it("preserves absolute paths", () => {
    expect(resolveLocalFileReference("D:/work/app/main.ts", "/ignored")).toBe(
      "D:/work/app/main.ts",
    );
    expect(resolveLocalFileReference("/work/app/main.ts", "D:/ignored")).toBe(
      "/work/app/main.ts",
    );
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
});
