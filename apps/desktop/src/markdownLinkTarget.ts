import { parseExternalUrl } from "./externalLinks";
import { resolveLocalFileReference, resolveWorkspacePath, type LocalFileTarget } from "./localFiles";

export type MarkdownLinkTarget = { kind: "file"; target: LocalFileTarget } | { kind: "url"; url: string };

/** One target for left-click, context-menu and clipboard actions. */
export function resolveMarkdownLinkTarget(href: string, base?: string | null, label?: string): MarkdownLinkTarget | null {
  if (!href || href.startsWith("#")) return null;
  const file = resolveLocalFileReference(href, base, label);
  if (file) return { kind: "file", target: file };
  const url = parseExternalUrl(href);
  if (url) return { kind: "url", url: url.href };
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href) && !/^[A-Za-z]:[\\/]/.test(href)) return null;
  const path = resolveWorkspacePath(href, base);
  return path ? { kind: "file", target: { path, line: null, column: null } } : null;
}

export function fileReferenceAttributes(target: LocalFileTarget) {
  return {
    "data-file-path": target.path,
    "data-file-line": target.line ?? undefined,
    "data-file-column": target.column ?? undefined,
  };
}
