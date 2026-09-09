export interface HtmlPreviewHandle {
  id: string;
  url: string;
}
export interface HtmlPreviewFile {
  path: string;
  workspacePath: string;
  workspacePaths: readonly string[];
}

export async function openHtmlPreview(
  file: HtmlPreviewFile,
  network: boolean,
): Promise<HtmlPreviewHandle> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("open_html_preview", { ...file, network });
}

export async function closeHtmlPreview(id: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("close_html_preview", { id });
}
