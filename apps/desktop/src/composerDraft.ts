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
