import { describe, expect, it, vi } from "vitest";
import { externalEditorUri, openInEditor } from "./externalEditor";

const openExternalUrl = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./externalLinks", () => ({ openExternalUrl }));

describe("external editor URIs", () => {
  it("encodes path characters while retaining line and column", () => {
    expect(externalEditorUri({ path: "/tmp/a b/#draft.ts", line: 12, column: 4 }, "vscode"))
      .toBe("vscode://file//tmp/a%20b/%23draft.ts?line=12&column=4");
  });

  it("supports Windows paths and ignores invalid locations", () => {
    expect(externalEditorUri({ path: "C:\\Work Folder\\main.ts", line: 0, column: -2 }, "cursor"))
      .toBe("cursor://file/C:/Work%20Folder/main.ts");
  });

  it("creates a file URI for the system handler", () => {
    expect(externalEditorUri({ path: "/tmp/report final.pdf" }, "system"))
      .toBe("file:///tmp/report%20final.pdf");
    expect(externalEditorUri({ path: "\\\\server\\share\\report.pdf" }, "system"))
      .toBe("file://server/share/report.pdf");
  });

  it("delegates opening to the platform opener", async () => {
    await openInEditor({ path: "/tmp/report.md", line: 3 }, "zed");
    expect(openExternalUrl).toHaveBeenCalledWith("zed://file//tmp/report.md?line=3");
  });
});
