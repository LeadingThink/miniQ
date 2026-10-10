import { deliverableFileType } from "./fileTypes";
import { resolveWorkspacePath } from "./localFiles";
import type { Artifact } from "./types";

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

function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href) && !/^[A-Za-z]:[\\/]/.test(href);
}

/**
 * Local deliverable files that a finished reply links to, as artifact cards.
 * Files any tool wrote count, not only those the daemon recorded as artifacts.
 * Source code is left to the turn changes card.
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
    const type = deliverableFileType(href);
    if (!type) continue;
    const path = resolveWorkspacePath(href, workspacePath);
    if (!path || seen.has(path) || knownPaths.has(path)) continue;
    seen.add(path);
    files.push({
      id: `reply:${message.id}:${files.length}`,
      sessionId: message.sessionId,
      path,
      kind: type.label,
      title: fileName(path),
      createdAt: message.createdAt,
    });
    if (files.length >= MAX_REPLY_FILES) break;
  }
  return files;
}
