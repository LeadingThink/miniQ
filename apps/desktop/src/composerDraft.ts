import type { PendingPaste } from "./largePaste";

const DRAFT_PREFIX = "miniq.draft.";

export function readDraft(key: string | undefined): string {
  if (!key) return "";
  try {
    return window.localStorage.getItem(DRAFT_PREFIX + key) ?? "";
  } catch {
    return "";
  }
}

export function storeDraft(key: string | undefined, value: string) {
  if (!key) return;
  try {
    if (value) window.localStorage.setItem(DRAFT_PREFIX + key, value);
    else window.localStorage.removeItem(DRAFT_PREFIX + key);
  } catch {
    /* storage unavailable */
  }
}

export function readAttachments(key?: string): string[] {
  if (!key) return [];
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(`${DRAFT_PREFIX}${key}.attachments`) ?? "[]",
    );
    return Array.isArray(value) &&
      value.every((path) => typeof path === "string")
      ? value
      : [];
  } catch {
    return [];
  }
}

export function storeAttachments(key: string | undefined, paths: string[]) {
  if (!key) return;
  try {
    if (paths.length)
      window.localStorage.setItem(
        `${DRAFT_PREFIX}${key}.attachments`,
        JSON.stringify(paths),
      );
    else window.localStorage.removeItem(`${DRAFT_PREFIX}${key}.attachments`);
  } catch {
    /* Draft remains in memory when browser storage is unavailable. */
  }
}

/** Collapsed pastes of a draft, so a placeholder never outlives its text. */
export function readPastes(key: string | undefined): PendingPaste[] {
  if (!key) return [];
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(`${DRAFT_PREFIX}${key}.pastes`) ?? "[]",
    );
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry: unknown) => {
      const paste = entry as Partial<PendingPaste> | null;
      return typeof paste?.placeholder === "string" && paste.placeholder &&
        typeof paste.text === "string"
        ? [{
            placeholder: paste.placeholder,
            text: paste.text,
            ...(typeof paste.label === "string" ? { label: paste.label } : {}),
            ...(paste.kind === "file-selection" ? { kind: paste.kind } : {}),
          }]
        : [];
    });
  } catch {
    return [];
  }
}

export function storePastes(key: string | undefined, pastes: readonly PendingPaste[]) {
  if (!key) return;
  try {
    if (pastes.length)
      window.localStorage.setItem(
        `${DRAFT_PREFIX}${key}.pastes`,
        JSON.stringify(pastes),
      );
    else window.localStorage.removeItem(`${DRAFT_PREFIX}${key}.pastes`);
  } catch {
    /* Draft remains in memory when browser storage is unavailable. */
  }
}
