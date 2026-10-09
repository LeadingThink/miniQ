import { downloadBlob } from "./downloadBlob";
import { isTauriRuntime } from "./runtime";

export interface ExportFile {
  /** File name without extension. */
  baseName: string;
  extension: string;
  /** Label for the file type filter in the save dialog. */
  filterName: string;
  mimeType: string;
  contents: string | Blob;
}

export type ExportResult =
  | { status: "saved"; path: string }
  | { status: "shared"; filename: string }
  | { status: "downloaded"; filename: string }
  | { status: "cancelled" };

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * Saves an export the way "Save as" does: the desktop app asks for a location
 * and name, mobile apps open the system share sheet, and browsers download.
 */
export async function saveExportFile(file: ExportFile): Promise<ExportResult> {
  const filename = `${file.baseName}.${file.extension}`;
  if (isTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const contents =
      typeof file.contents === "string"
        ? file.contents
        : // Keep a leading BOM: spreadsheet apps rely on it for UTF-8 CSV.
          new TextDecoder("utf-8", { ignoreBOM: true }).decode(
            await file.contents.arrayBuffer(),
          );
    const path = await invoke<string | null>("save_export_file", {
      fileName: filename,
      extension: file.extension,
      filterName: file.filterName,
      contents,
    });
    return path ? { status: "saved", path } : { status: "cancelled" };
  }
  const blob = new Blob([file.contents], { type: file.mimeType });
  const { Capacitor } = await import("@capacitor/core");
  if (Capacitor.isNativePlatform() && typeof navigator.share === "function") {
    const shared = new File([blob], filename, { type: file.mimeType });
    if (navigator.canShare?.({ files: [shared] }) ?? false) {
      try {
        await navigator.share({ files: [shared], title: filename });
        return { status: "shared", filename };
      } catch (error) {
        if (isAbort(error)) return { status: "cancelled" };
        throw error;
      }
    }
  }
  downloadBlob(blob, filename);
  return { status: "downloaded", filename };
}

export async function revealExportedFile(path: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("reveal_exported_file", { path });
}

export function exportResultMessage(result: ExportResult): string | null {
  switch (result.status) {
    case "saved":
      return `已导出到 ${result.path}`;
    case "shared":
      return `已导出 ${result.filename}`;
    case "downloaded":
      return `已下载 ${result.filename}，请在浏览器下载目录查看`;
    case "cancelled":
      return null;
  }
}
