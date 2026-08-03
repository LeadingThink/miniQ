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
const TEXT_PREVIEW_EXTENSIONS = new Set([
  "bash", "bat", "c", "cc", "cjs", "conf", "cpp", "cs", "css", "csv",
  "diff", "env", "fish", "go", "h", "hpp", "htm", "html", "ini", "java",
  "js", "json", "jsonl", "jsx", "kt", "kts", "less", "lock", "log",
  "markdown", "md", "mjs", "patch", "php", "ps1", "py", "pyi", "rb", "rs",
  "rst", "sass", "scss", "sh", "sql", "svelte", "svg", "swift", "toml", "ts",
  "tsv", "tsx", "txt", "vue", "xml", "yaml", "yml", "zsh",
]);
const TEXT_PREVIEW_NAMES = new Set([
  ".dockerignore",
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".gitmodules",
  ".npmrc",
  ".prettierignore",
  ".prettierrc",
  "changelog",
  "dockerfile",
  "license",
  "makefile",
  "readme",
]);

export interface LocalFileTarget {
  path: string;
  line: number | null;
  column: number | null;
}

export interface LocalTextFile {
  path: string;
  content: string;
}

function decodePath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseLocation(reference: string): {
  reference: string;
  line: number | null;
  column: number | null;
} {
  const value = reference.trim();
  const patterns = [
    /#L(?<line>\d+)(?:C(?<column>\d+))?$/i,
    /(?<extension>\.[A-Za-z][A-Za-z0-9_-]{0,15}):(?<line>\d+)(?::(?<column>\d+))?$/,
    /\s*\((?:line\s*)?(?<line>\d+)(?:\s*[,，:]\s*(?:column\s*)?(?<column>\d+))?\)$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (!match?.groups?.line) continue;
    const extension = match.groups.extension ?? "";
    return {
      reference: `${value.slice(0, match.index)}${extension}`.trim(),
      line: Number(match.groups.line),
      column: match.groups.column ? Number(match.groups.column) : null,
    };
  }
  return { reference: value, line: null, column: null };
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
  const value = parseLocation(reference).reference;
  if (!value || /[\r\n<>|*]/.test(value)) return false;
  if (URL_SCHEME.test(value) && !WINDOWS_DRIVE.test(value) && !/^file:/i.test(value)) {
    return false;
  }

  const path = /^file:/i.test(value) ? fileUriPath(value) : decodePath(value);
  if (!path) return false;
  if (path.split(/[\\/]/).some((segment) => segment === "..." || segment === "…")) {
    return false;
  }
  const name = path.split(/[\\/]/).at(-1) ?? "";
  const extension = /\.([A-Za-z0-9_-]+)$/.exec(name)?.[1].toLowerCase();
  return (
    NAMED_FILES.test(name) ||
    (extension !== undefined && FILE_EXTENSIONS.has(extension)) ||
    isTextPreviewFile(path)
  );
}

export function isTextPreviewFile(path: string): boolean {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (TEXT_PREVIEW_NAMES.has(name) || /^\.env(?:\..+)?$/.test(name)) return true;
  const extension = /\.([A-Za-z0-9_-]+)$/.exec(name)?.[1].toLowerCase();
  return extension !== undefined && TEXT_PREVIEW_EXTENSIONS.has(extension);
}

export function resolveLocalFileReference(
  reference: string,
  workspacePath?: string | null,
  locationReference?: string | null,
): LocalFileTarget | null {
  if (!looksLikeFileReference(reference)) return null;
  const location = parseLocation(reference);
  const fallbackLocation = locationReference ? parseLocation(locationReference) : null;
  const path = resolveWorkspacePath(location.reference, workspacePath);
  if (!path) return null;
  return {
    path,
    line: location.line ?? fallbackLocation?.line ?? null,
    column: location.column ?? fallbackLocation?.column ?? null,
  };
}

export function resolveWorkspacePath(
  reference: string,
  workspacePath?: string | null,
): string | null {
  const stripped = parseLocation(reference).reference;
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

export async function readLocalTextFile(
  path: string,
  workspacePath?: string | null,
): Promise<LocalTextFile> {
  if (!workspacePath) throw new Error("无法预览文件：当前会话没有工作区");
  if (!isTauriRuntime()) throw new Error("文件预览仅在 miniQ 桌面应用中可用");
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<LocalTextFile>("read_local_text_file", { path, workspacePath });
}

function browserFileUrl(path: string) {
  const normalized = path.replaceAll("\\", "/");
  return encodeURI(WINDOWS_DRIVE.test(normalized) ? `file:///${normalized}` : `file://${normalized}`);
}

export async function openLocalFile(
  path: string,
  workspacePath?: string | null,
): Promise<void> {
  if (isTauriRuntime()) {
    if (!workspacePath) throw new Error("无法打开文件：当前会话没有工作区");
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("open_local_file", { path, workspacePath });
    return;
  }
  window.open(browserFileUrl(path), "_blank", "noopener,noreferrer");
}

export async function revealLocalFile(
  path: string,
  workspacePath?: string | null,
): Promise<void> {
  if (isTauriRuntime()) {
    if (!workspacePath) throw new Error("无法定位文件：当前会话没有工作区");
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("reveal_local_file", { path, workspacePath });
  }
}
