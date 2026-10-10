import { resolveWorkspacePath } from "./localFiles";
import type { Artifact } from "./types";

/** File types a reply hands to the user. Source code is shown by the turn changes card instead. */
const DELIVERABLE_KINDS: Record<string, string> = {
  pdf: "PDF",
  doc: "Word", docx: "Word",
  xls: "Excel", xlsx: "Excel", csv: "CSV",
  ppt: "PPT", pptx: "PPT",
  key: "Keynote", pages: "Pages", numbers: "Numbers",
  png: "图片", jpg: "图片", jpeg: "图片", gif: "图片", webp: "图片", svg: "图片", heic: "图片",
  mp3: "音频", wav: "音频", m4a: "音频", flac: "音频",
  mp4: "视频", mov: "视频", webm: "视频",
  zip: "压缩包", tar: "压缩包", gz: "压缩包", "7z": "压缩包", dmg: "安装包", apk: "安装包",
  md: "Markdown", html: "HTML", txt: "文本", epub: "电子书",
};

/** Most cards one reply shows, so a long file list does not bury the conversation. */
export const MAX_REPLY_FILES = 6;

// [label](path), [label](<path with spaces>), optional "title".
const MARKDOWN_LINK = /\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;

function stripCode(content: string): string {
  return content.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function extension(path: string): string {
  const name = fileName(path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href) && !/^[A-Za-z]:[\\/]/.test(href);
}

/**
 * Local deliverable files that a finished reply links to, as artifact cards.
 * Files any tool wrote count, not only those the daemon recorded as artifacts.
 */
export function replyFileArtifacts(
  message: { id: string; sessionId: string; content: string; createdAt: string },
  workspacePath: string | null | undefined,
  knownPaths: ReadonlySet<string> = new Set(),
): Artifact[] {
  const seen = new Set<string>();
  const files: Artifact[] = [];
  for (const match of stripCode(message.content).matchAll(MARKDOWN_LINK)) {
    const href = (match[1] ?? match[2]).trim();
    if (isExternal(href)) continue;
    const kind = DELIVERABLE_KINDS[extension(href.split(/[?#]/)[0])];
    if (!kind) continue;
    const path = resolveWorkspacePath(href, workspacePath);
    if (!path || seen.has(path) || knownPaths.has(path)) continue;
    seen.add(path);
    files.push({
      id: `reply:${message.id}:${files.length}`,
      sessionId: message.sessionId,
      path,
      kind,
      title: fileName(path),
      createdAt: message.createdAt,
    });
    if (files.length >= MAX_REPLY_FILES) break;
  }
  return files;
}
