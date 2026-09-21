import { openExternalUrl } from "./externalLinks";

/** Editors that can open a local file at an optional line and column. */
export type ExternalEditor = "vscode" | "cursor" | "zed";

export interface ExternalEditorTarget {
  path: string;
  line?: number | null;
  column?: number | null;
}

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/** Encode path segments without allowing a path to change URI query/fragment. */
function encodePath(path: string): string {
  const normalized = WINDOWS_DRIVE.test(path) || path.startsWith("\\\\")
    ? path.replaceAll("\\", "/")
    : path;
  return normalized
    .split("/")
    .map((segment, index) => index === 0 && /^[A-Za-z]:$/.test(segment)
      ? segment
      : encodeURIComponent(segment))
    .join("/");
}

function locationSuffix(target: ExternalEditorTarget): string {
  const line = Number.isSafeInteger(target.line) && (target.line ?? 0) > 0 ? target.line : null;
  const column = Number.isSafeInteger(target.column) && (target.column ?? 0) > 0 ? target.column : null;
  if (line === null) return "";
  return `:${line}${column === null ? "" : `:${column}`}`;
}

/** Build an editor file URI. All supported editors use a :line:column suffix. */
export function externalEditorUri(
  target: ExternalEditorTarget,
  editor: ExternalEditor,
): string {
  const path = target.path;
  if (!path.trim()) throw new Error("无法打开文件：缺少文件路径");
  if (!path.startsWith("/") && !path.startsWith("\\\\") && !WINDOWS_DRIVE.test(path)) {
    throw new Error("无法打开文件：外部编辑器需要本机文件的绝对路径");
  }
  const encoded = encodePath(path);
  const filePath = WINDOWS_DRIVE.test(path) ? `/${encoded}` : encoded;
  return `${editor}://file${filePath}${locationSuffix(target)}`;
}

/** Open a previewed local file in the chosen external editor. */
export async function openInEditor(
  target: ExternalEditorTarget,
  editor: ExternalEditor,
): Promise<void> {
  await openExternalUrl(externalEditorUri(target, editor));
}
