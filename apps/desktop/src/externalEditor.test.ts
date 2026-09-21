import { describe, expect, it, vi } from "vitest";
import { externalEditorUri, openInEditor } from "./externalEditor";

const openExternalUrl = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./externalLinks", () => ({ openExternalUrl }));

describe("external editor URIs", () => {
  it.each(["vscode", "cursor", "zed"] as const)("uses %s file and line-column syntax", (editor) => {
    expect(externalEditorUri({ path: "/tmp/a b/#draft?.ts", line: 12, column: 4 }, editor))
      .toBe(`${editor}://file/tmp/a%20b/%23draft%3F.ts:12:4`);
  });

  it("retains literal filename whitespace and percent signs", () => {
    expect(externalEditorUri({ path: "/tmp/  100% complete.md " }, "vscode"))
      .toBe("vscode://file/tmp/%20%20100%25%20complete.md%20");
    expect(externalEditorUri({ path: "/tmp/path\\part.md" }, "vscode"))
      .toBe("vscode://file/tmp/path%5Cpart.md");
  });

  it("supports Windows paths and ignores invalid locations", () => {
    expect(externalEditorUri({ path: "C:\\Work Folder\\main.ts", line: 0, column: -2 }, "cursor"))
      .toBe("cursor://file/C:/Work%20Folder/main.ts");
  });

  it("retains UNC paths and accepts line-only locations", () => {
    expect(externalEditorUri({ path: "\\\\server\\share\\report.md", line: 3 }, "cursor"))
      .toBe("cursor://file//server/share/report.md:3");
  });

  it("ignores invalid line-column locations", () => {
    expect(externalEditorUri({ path: "/tmp/report.md", line: 2.5, column: 4 }, "zed"))
      .toBe("zed://file/tmp/report.md");
    expect(externalEditorUri({ path: "/tmp/report.md", line: 12, column: -3 }, "zed"))
      .toBe("zed://file/tmp/report.md:12");
  });

  it.each(["", "  ", "report.md", "ssh://host/tmp/report.md"])("rejects non-local absolute paths: %s", (path) => {
    expect(() => externalEditorUri({ path }, "vscode")).toThrow();
  });

  it("delegates opening to the platform opener", async () => {
    await openInEditor({ path: "/tmp/report.md", line: 3 }, "zed");
    expect(openExternalUrl).toHaveBeenCalledWith("zed://file/tmp/report.md:3");
  });
});
