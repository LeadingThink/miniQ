import { isInside, normalizePath } from "./fileTreeModel";
import { revealLocalFile } from "./localFiles";
import { isTauriRuntime } from "./runtime";

/** Event consumed by the composer to insert text at the caret. */
export const COMPOSER_INSERT_EVENT = "miniq:composer-insert";

export interface ComposerInsertDetail {
  text: string;
}

/** Path relative to the deepest workspace root containing it; the input path otherwise. */
export function relativePath(path: string, roots: readonly (string | null | undefined)[]): string {
  const target = normalizePath(path);
  const root = roots
    .filter((value): value is string => Boolean(value && value.trim()))
    .map(normalizePath)
    .filter((value) => isInside(target, value))
    .sort((a, b) => b.length - a.length)[0];
  if (!root) return target;
  if (root === target) return ".";
  return target.slice(root.endsWith("/") ? root.length : root.length + 1);
}

/** `@path ` mention; paths with whitespace are wrapped in backticks. */
export function chatMentionText(relative: string): string {
  return `@${/\s/.test(relative) ? `\`${relative}\`` : relative} `;
}

export function insertIntoComposer(text: string): void {
  window.dispatchEvent(
    new CustomEvent<ComposerInsertDetail>(COMPOSER_INSERT_EVENT, { detail: { text } }),
  );
}

export function addPathToChat(path: string, roots: readonly (string | null | undefined)[]): void {
  insertIntoComposer(chatMentionText(relativePath(path, roots)));
}

export async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error("无法访问剪贴板");
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    throw new Error("无法访问剪贴板");
  }
}

export interface RevealOptions {
  directory?: boolean;
  workspacePath?: string | null;
  workspacePaths?: readonly string[];
  authorizedFiles?: readonly string[];
}

/** Show a local file or folder in Finder (desktop app only). */
export async function revealInFinder(path: string, options: RevealOptions = {}): Promise<void> {
  if (!isTauriRuntime()) throw new Error("仅桌面应用可以在 Finder 中显示");
  if (options.directory) {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
    return;
  }
  await revealLocalFile(
    path,
    options.workspacePath,
    options.workspacePaths ?? [],
    options.authorizedFiles ?? [],
  );
}

/** Parse a 1-based line number; returns an error message when out of range. */
export function parseLineNumber(
  value: string,
  max: number,
): { line: number; error: null } | { line: null; error: string } {
  const limit = Math.max(1, Math.floor(max));
  const text = value.trim();
  const line = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(line) || line < 1 || line > limit) {
    return { line: null, error: `请输入 1 到 ${limit} 之间的行号` };
  }
  return { line, error: null };
}
