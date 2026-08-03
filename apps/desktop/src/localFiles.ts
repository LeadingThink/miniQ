import { isTauriRuntime } from "./runtime";

const NAMED_FILES = /^(?:Dockerfile|Makefile|README|LICENSE|CHANGELOG)(?:\.[A-Za-z0-9]+)?$/i;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const FILE_EXTENSIONS = new Set([
  "7z", "aab", "apk", "bash", "bat", "bmp", "c", "cc", "cjs", "conf",
  "cpp", "cs", "css", "csv", "doc", "docx", "env", "fish", "gif", "go",
  "gz", "h", "hpp", "htm", "html", "ico", "ini", "ipa", "jar", "java",
  "jpeg", "jpg", "jks", "js", "json", "jsonl", "jsx", "keystore", "kt",
  "kts", "less", "lock", "log", "markdown", "md", "mjs", "mov", "mp3",
  "mp4", "pdf", "php", "png", "ppt", "pptx", "ps1", "py", "pyi", "rar",
  "rb", "rs", "rst", "sass", "scss", "sh", "sql", "svelte", "svg", "swift",
  "tar", "tgz", "toml", "ts", "tsv", "tsx", "txt", "vue", "wasm", "wav",
  "webm", "webp", "xls", "xlsx", "xml", "yaml", "yml", "zsh", "zip",
]);

function decodePath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function stripLocation(reference: string) {
  return reference
    .replace(/#L\d+(?:C\d+)?$/i, "")
    .replace(/(\.[A-Za-z][A-Za-z0-9_-]{0,15}):\d+(?::\d+)?$/, "$1");
}

function fileUriPath(reference: string) {
  try {
    const url = new URL(reference);
    let path = decodePath(url.pathname);
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    if (url.host && url.host !== "localhost") {
      return `\\\\${url.host}${path.replaceAll("/", "\\")}`;
    }
    return path;
  } catch {
    return null;
  }
}

export function looksLikeFileReference(reference: string): boolean {
  const value = stripLocation(reference.trim());
  if (!value || /[\r\n<>|*]/.test(value)) return false;
  if (URL_SCHEME.test(value) && !WINDOWS_DRIVE.test(value) && !/^file:/i.test(value)) {
    return false;
  }

  const path = /^file:/i.test(value) ? fileUriPath(value) : decodePath(value);
  if (!path) return false;
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const extension = /\.([A-Za-z0-9_-]+)$/.exec(name)?.[1].toLowerCase();
  return (
    NAMED_FILES.test(name) ||
    (extension !== undefined && FILE_EXTENSIONS.has(extension)) ||
    /^\.(?:env|gitignore|npmrc|prettierignore|prettierrc)$/.test(name)
  );
}

export function resolveLocalFileReference(
  reference: string,
  workspacePath?: string | null,
): string | null {
  if (!looksLikeFileReference(reference)) return null;
  return resolveWorkspacePath(reference, workspacePath);
}

export function resolveWorkspacePath(
  reference: string,
  workspacePath?: string | null,
): string | null {
  const stripped = stripLocation(reference.trim());
  let path = /^file:/i.test(stripped) ? fileUriPath(stripped) : decodePath(stripped);
  if (!path) return null;
  if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
  if (WINDOWS_DRIVE.test(path) || path.startsWith("/") || path.startsWith("\\\\")) {
    return path;
  }
  if (!workspacePath) return null;

  const separator = workspacePath.includes("\\") ? "\\" : "/";
  path = path.replace(/[\\/]/g, separator).replace(/^\.([\\/])/, "");
  return `${workspacePath.replace(/[\\/]+$/, "")}${separator}${path}`;
}

function browserFileUrl(path: string) {
  const normalized = path.replaceAll("\\", "/");
  return encodeURI(WINDOWS_DRIVE.test(normalized) ? `file:///${normalized}` : `file://${normalized}`);
}

export async function openLocalFile(path: string): Promise<void> {
  if (isTauriRuntime()) {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(path);
    return;
  }
  window.open(browserFileUrl(path), "_blank", "noopener,noreferrer");
}

export async function revealLocalFile(path: string): Promise<void> {
  if (isTauriRuntime()) {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  }
}
