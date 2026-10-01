import type { RemoteDirectory } from "./remoteFiles";

export type TreeEntry = RemoteDirectory["entries"][number];

export interface TreeDirectory {
  entries: TreeEntry[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
}

export interface TreeRow {
  entry: TreeEntry;
  depth: number;
  expanded: boolean;
  parent: string | null;
}

export type FileKind =
  | "code"
  | "web"
  | "data"
  | "sheet"
  | "doc"
  | "pdf"
  | "slides"
  | "image"
  | "video"
  | "audio"
  | "archive"
  | "text";

const KINDS: Record<FileKind, string[]> = {
  code: [
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "kt",
    "swift", "c", "h", "cc", "cpp", "hpp", "cs", "rb", "php", "sh", "bash",
    "zsh", "lua", "sql", "vue", "svelte", "scala", "dart", "r",
  ],
  web: ["html", "htm", "css", "scss", "less"],
  data: ["json", "jsonl", "yaml", "yml", "toml", "xml", "ini", "env", "lock"],
  sheet: ["xlsx", "xls", "xlsm", "csv", "tsv", "numbers", "ods"],
  doc: ["md", "mdx", "markdown", "doc", "docx", "pages", "odt", "rtf"],
  pdf: ["pdf"],
  slides: ["ppt", "pptx", "key", "odp"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "heic", "tiff"],
  video: ["mp4", "mov", "webm", "mkv", "avi", "m4v"],
  audio: ["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus"],
  archive: ["zip", "gz", "tgz", "tar", "rar", "7z", "bz2", "xz", "dmg", "apk"],
  text: [],
};

const KIND_BY_EXT = new Map(
  Object.entries(KINDS).flatMap(([kind, exts]) =>
    exts.map((ext) => [ext, kind as FileKind] as const),
  ),
);

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1
    ? name.slice(dot + 1).toLocaleLowerCase()
    : "";
}

export function fileKind(name: string): FileKind {
  return KIND_BY_EXT.get(fileExtension(name)) ?? "text";
}

/** Splits a name so the UI can ellipsize the stem while keeping the extension visible. */
export function splitFileName(name: string): { stem: string; tail: string } {
  const ext = fileExtension(name);
  if (!ext || ext.length > 8 || name.length <= ext.length + 12)
    return { stem: name, tail: "" };
  return { stem: name.slice(0, -(ext.length + 1)), tail: `.${name.slice(-ext.length)}` };
}

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function sortEntries(entries: readonly TreeEntry[]): TreeEntry[] {
  return [...entries].sort(
    (a, b) =>
      Number(b.directory) - Number(a.directory) ||
      collator.compare(a.name, b.name),
  );
}

export function normalizePath(path: string): string {
  const value = path.replace(/\\/g, "/");
  return value.length > 1 ? value.replace(/\/+$/, "") : value;
}

export function isInside(path: string, root: string): boolean {
  const child = normalizePath(path);
  const parent = normalizePath(root);
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/** Directories between root (exclusive) and the file (exclusive). */
export function ancestorDirectories(root: string, file: string): string[] {
  const base = normalizePath(root);
  const target = normalizePath(file);
  if (!isInside(target, base) || target === base) return [];
  const parts = target.slice(base.length).split("/").filter(Boolean);
  parts.pop();
  const result: string[] = [];
  let current = base;
  for (const part of parts) {
    current = current.endsWith("/") ? `${current}${part}` : `${current}/${part}`;
    result.push(current);
  }
  return result;
}

/**
 * Flattens the loaded tree into visible rows. When filtering, only rows that
 * match (or contain loaded matches) remain and folders with matches open.
 */
export function visibleRows(
  root: string,
  directories: ReadonlyMap<string, TreeDirectory>,
  expanded: ReadonlySet<string>,
  query: string,
): TreeRow[] {
  const needle = query.trim().toLocaleLowerCase();
  const matches = new Map<string, boolean>();
  const contains = (entry: TreeEntry): boolean => {
    const known = matches.get(entry.path);
    if (known !== undefined) return known;
    matches.set(entry.path, false);
    const own = entry.name.toLocaleLowerCase().includes(needle);
    const children = entry.directory
      ? (directories.get(normalizePath(entry.path))?.entries ?? [])
      : [];
    const value = own || children.some(contains);
    matches.set(entry.path, value);
    return value;
  };
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    const node = directories.get(normalizePath(dir));
    if (!node) return;
    for (const entry of sortEntries(node.entries)) {
      if (needle && !contains(entry)) continue;
      const key = normalizePath(entry.path);
      const childMatches =
        needle &&
        entry.directory &&
        (directories.get(key)?.entries ?? []).some(contains);
      const open =
        entry.directory && (expanded.has(key) || Boolean(childMatches));
      rows.push({ entry, depth, expanded: open, parent: depth ? dir : null });
      if (open) walk(entry.path, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/** Project-relative location such as "docs › api › guide.md". */
export function breadcrumb(path: string, roots: readonly string[]): string {
  const segments = breadcrumbSegments(path, roots);
  return segments.length ? segments.map((segment) => segment.label).join(" › ") : path;
}

export interface BreadcrumbSegment {
  label: string;
  /** Absolute path of this segment; the last one is the file itself. */
  path: string;
  directory: boolean;
}

/**
 * Splits a file path into clickable segments relative to the deepest
 * workspace root that contains it. Returns [] when the file is outside
 * every root.
 */
export function breadcrumbSegments(
  path: string,
  roots: readonly string[],
): BreadcrumbSegment[] {
  const target = path.replace(/\\/g, "/");
  const root = roots
    .map((value) => value.replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter((value) => value && target.startsWith(`${value}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (!root) return [];
  const parts = target.slice(root.length + 1).split("/").filter(Boolean);
  const segments: BreadcrumbSegment[] = [
    { label: root.split("/").at(-1) || root, path: root, directory: true },
  ];
  let current = root;
  parts.forEach((part, index) => {
    current = `${current}/${part}`;
    segments.push({ label: part, path: current, directory: index < parts.length - 1 });
  });
  return segments;
}
