import type { RevealOptions } from "./fileActions";
import { openExternalUrl, parseExternalUrl } from "./externalLinks";
import { isTauriRuntime } from "./runtime";
import { readLocalTextFile } from "./localFiles";
import { readRemoteFile, type FileReadOptions } from "./remoteFiles";
import type { SignedDownload } from "./remoteTransfer";

export interface FileOpenApplication {
  id: string;
  name: string;
  isDefault: boolean;
}

function fileArguments(path: string, scope: RevealOptions) {
  if (!scope.workspacePath) throw new Error("当前会话没有工作区");
  return {
    path,
    workspacePath: scope.workspacePath,
    workspacePaths: scope.workspacePaths ?? [],
    authorizedFiles: scope.authorizedFiles ?? [],
  };
}

export async function fileOpenApplications(path: string, scope: RevealOptions): Promise<FileOpenApplication[]> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("file_open_applications", fileArguments(path, scope));
}

export async function openLocalFileWith(path: string, applicationId: string, scope: RevealOptions): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("open_local_file_with", { ...fileArguments(path, scope), applicationId });
}

export async function saveLocalFileAs(path: string, scope: RevealOptions): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("save_local_file_as", fileArguments(path, scope));
}

export async function saveExternalLinkAs(href: string): Promise<string | null> {
  const url = parseExternalUrl(href);
  if (!url || !/^https?:$/.test(url.protocol)) throw new Error("只能保存 HTTP 或 HTTPS 链接");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("save_external_link_as", { url: url.href });
}

/** Separate window, with no miniQ IPC permissions granted to the external page. */
export async function openLinkWindow(href: string): Promise<void> {
  const url = parseExternalUrl(href);
  if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("无法打开此链接");
  }
  if (!isTauriRuntime()) {
    window.open(url.href, "_blank", "popup,noopener,noreferrer,width=1100,height=760");
    return;
  }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  await new Promise<void>((resolve, reject) => {
    const view = new WebviewWindow(`link-${crypto.randomUUID()}`, {
      url: url.href, title: url.hostname, width: 1100, height: 760,
    });
    void view.once("tauri://created", () => resolve());
    void view.once<string>("tauri://error", (event) => reject(new Error(String(event.payload))));
  });
}

export function revealFileLabel(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent;
  if (/Mac/i.test(platform)) return "在 Finder 中显示";
  if (/Win/i.test(platform)) return "在文件资源管理器中显示";
  return "在文件管理器中显示";
}

export async function fileText(path: string, scope: RevealOptions, access?: FileReadOptions): Promise<string> {
  if (isTauriRuntime() && access?.client?.mode !== "remote") {
    return (await readLocalTextFile(path, scope.workspacePath, scope.workspacePaths, scope.authorizedFiles)).content;
  }
  const file = await readRemoteFile(path, { ...access, download: true });
  if (!file.blob) throw new Error("无法读取文件内容");
  return new TextDecoder("utf-8", { fatal: true }).decode(await file.blob.arrayBuffer());
}

export async function downloadFileToDevice(path: string, access: FileReadOptions): Promise<void> {
  const { Capacitor } = await import("@capacitor/core");
  if (Capacitor.isNativePlatform()) {
    if (!access.client || !access.sessionId) throw new Error("请先连接桌面并打开会话");
    const { validateDescriptor } = await import("./remoteTransfer");
    const { saveRemoteFile } = await import("./nativeFileTransfer");
    const description = await access.client.call<{ revision: string; mimeType: string }>("file.describe", { sessionId: access.sessionId, path });
    const signed = validateDescriptor(await access.client.call<SignedDownload>("file.download.prepare", {
      sessionId: access.sessionId, path, revision: description.revision,
    }, { timeoutMs: 600000 }));
    try {
      const result = await saveRemoteFile({ url: signed.getUrl, filename: path.split(/[\\/]/).at(-1) || "download", mimeType: description.mimeType, size: signed.size, sha256: signed.sha256 });
      if (result.status !== "cancelled") return;
    } catch (cause) {
      await access.client.call("file.transfer.cancel", { sessionId: access.sessionId, transferId: signed.transferId }).catch(() => {});
      throw cause;
    }
    await access.client.call("file.transfer.cancel", { sessionId: access.sessionId, transferId: signed.transferId });
    return;
  }
  const file = await readRemoteFile(path, { ...access, download: true });
  if (!file.blob) throw new Error("无法下载文件");
  const url = URL.createObjectURL(file.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = path.split(/[\\/]/).at(-1) || "download";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export { openExternalUrl };
