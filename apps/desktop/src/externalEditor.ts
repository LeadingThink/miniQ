import { openExternalUrl } from "./externalLinks";

/** Editors that can open a local file at an optional line and column. */
export type ExternalEditor = "vscode" | "cursor" | "zed" | "system";

export interface ExternalEditorTarget {
  path: string;
  line?: number | null;
  column?: number | null;
}

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/** Encode path segments without allowing a path to change URI query/fragment. */
function encodePath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment).replaceAll("%3A", ":"))
    .join("/");
}

function locationQuery(target: ExternalEditorTarget): string {
  const line = Number.isInteger(target.line) && (target.line ?? 0) > 0 ? target.line : null;
  const column = Number.isInteger(target.column) && (target.column ?? 0) > 0 ? target.column : null;
  if (line === null) return "";
  return `?line=${line}${column === null ? "" : `&column=${column}`}`;
}

/** Build a safe URI for an installed editor or the system file handler. */
export function externalEditorUri(
  target: ExternalEditorTarget,
  editor: ExternalEditor,
): string {
  const path = target.path.trim();
  if (!path) throw new Error("无法打开文件：缺少文件路径");
  const encoded = encodePath(path);
  if (editor === "system") {
    // A drive letter must follow the third slash in a file URI. UNC paths keep
    // their host segment (//server/share) intact.
    if (path.startsWith("//") || path.startsWith("\\\\")) {
      const unc = encoded.replace(/^\/\//, "");
      return `file://${unc}`;
    }
    const filePath = WINDOWS_DRIVE.test(path) ? `/${encoded}` : encoded;
    return `file://${filePath}`;
  }
  const scheme = editor === "vscode" ? "vscode" : editor;
  return `${scheme}://file/${encoded}${locationQuery(target)}`;
}

/** Open a previewed local file in the chosen external editor. */
export async function openInEditor(
  target: ExternalEditorTarget,
  editor: ExternalEditor,
): Promise<void> {
  await openExternalUrl(externalEditorUri(target, editor));
}
