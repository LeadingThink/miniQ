/** File type of a delivered file, shared by reply file detection and artifact cards. */
export type FileType =
  | "pdf" | "word" | "excel" | "ppt" | "image" | "audio" | "video"
  | "archive" | "markdown" | "html" | "text" | "ebook" | "other";

export interface FileTypeInfo {
  type: FileType;
  /** Short label shown on the card badge. */
  label: string;
}

const EXTENSIONS: Record<string, FileTypeInfo> = {};
function register(type: FileType, label: string, extensions: string[]) {
  for (const extension of extensions) EXTENSIONS[extension] = { type, label };
}
register("pdf", "PDF", ["pdf"]);
register("word", "Word", ["doc", "docx", "pages", "rtf"]);
register("excel", "Excel", ["xls", "xlsx", "numbers"]);
register("excel", "CSV", ["csv"]);
register("ppt", "PPT", ["ppt", "pptx", "key"]);
register("image", "图片", ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic"]);
register("audio", "音频", ["mp3", "wav", "m4a", "flac"]);
register("video", "视频", ["mp4", "mov", "webm"]);
register("archive", "压缩包", ["zip", "tar", "gz", "7z"]);
register("archive", "安装包", ["dmg", "apk"]);
register("markdown", "Markdown", ["md", "markdown"]);
register("html", "HTML", ["html", "htm"]);
register("text", "文本", ["txt"]);
register("ebook", "电子书", ["epub"]);

/** Artifact kinds the daemon reports when the path has no known extension. */
const KINDS: Record<string, FileTypeInfo> = {
  image: { type: "image", label: "图片" },
  audio: { type: "audio", label: "音频" },
  speech: { type: "audio", label: "音频" },
  video: { type: "video", label: "视频" },
};

export function fileExtension(path: string): string {
  const name = (path.split(/[?#]/)[0].split(/[\\/]/).at(-1) ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

/** A deliverable file type, or null for source code and unknown files. */
export function deliverableFileType(path: string): FileTypeInfo | null {
  return EXTENSIONS[fileExtension(path)] ?? null;
}

/** Type for a card: the path extension wins, then the reported kind. */
export function fileTypeInfo(path: string, kind?: string): FileTypeInfo {
  const byPath = deliverableFileType(path);
  if (byPath) return byPath;
  const normalized = kind?.trim().toLowerCase() ?? "";
  return KINDS[normalized] ?? EXTENSIONS[normalized] ?? { type: "other", label: kind?.trim() || "文件" };
}
