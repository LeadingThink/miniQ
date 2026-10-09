import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const downloadBlob = vi.fn();
let tauri = false;
let native = false;

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./downloadBlob", () => ({ downloadBlob }));
vi.mock("./runtime", () => ({ isTauriRuntime: () => tauri }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native },
}));

const { saveExportFile, exportResultMessage } = await import("./saveExport");

const file = {
  baseName: "报告",
  extension: "md",
  filterName: "Markdown",
  mimeType: "text/markdown;charset=utf-8",
  contents: "# hi",
};

afterEach(() => {
  invoke.mockReset();
  downloadBlob.mockReset();
  tauri = false;
  native = false;
});

describe("saveExportFile", () => {
  it("asks the desktop app for a save location and reports the path", async () => {
    tauri = true;
    invoke.mockResolvedValue("/Users/me/Desktop/报告.md");
    const result = await saveExportFile(file);
    expect(invoke).toHaveBeenCalledWith("save_export_file", {
      fileName: "报告.md",
      extension: "md",
      filterName: "Markdown",
      contents: "# hi",
    });
    expect(result).toEqual({ status: "saved", path: "/Users/me/Desktop/报告.md" });
    expect(exportResultMessage(result)).toBe("已导出到 /Users/me/Desktop/报告.md");
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("treats a cancelled dialog as silent", async () => {
    tauri = true;
    invoke.mockResolvedValue(null);
    const result = await saveExportFile(file);
    expect(result).toEqual({ status: "cancelled" });
    expect(exportResultMessage(result)).toBeNull();
  });

  it("keeps the CSV byte order mark when saving a blob on desktop", async () => {
    tauri = true;
    invoke.mockResolvedValue("/tmp/a.csv");
    await saveExportFile({
      ...file,
      extension: "csv",
      contents: new Blob(["\uFEFFa,b\r\n"]),
    });
    expect(invoke.mock.calls[0][1].contents).toBe("\uFEFFa,b\r\n");
  });

  it("falls back to a browser download outside the apps", async () => {
    const result = await saveExportFile(file);
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "报告.md");
    expect(result).toEqual({ status: "downloaded", filename: "报告.md" });
  });

  it("opens the share sheet in the mobile app", async () => {
    native = true;
    const share = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { share, canShare: () => true });
    try {
      const result = await saveExportFile(file);
      expect(share).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ status: "shared", filename: "报告.md" });
      expect(downloadBlob).not.toHaveBeenCalled();
    } finally {
      Object.assign(navigator, { share: undefined, canShare: undefined });
    }
  });
});
