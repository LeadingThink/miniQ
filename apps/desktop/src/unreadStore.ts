/** Persist the per-host "unread" session set so badges survive a restart. */
export const UNREAD_STORAGE_PREFIX = "miniq.unread.v1:";
const LIMIT = 500;

export function loadUnread(key: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(UNREAD_STORAGE_PREFIX + key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveUnread(key: string, ids: ReadonlySet<string>) {
  try {
    const storageKey = UNREAD_STORAGE_PREFIX + key;
    if (!ids.size) window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, JSON.stringify([...ids].slice(-LIMIT)));
  } catch {
    // Storage may be unavailable; unread state then stays in memory only.
  }
}

/** Drop ids of sessions that no longer exist once a catalog has loaded. */
export function pruneUnread(ids: ReadonlySet<string>, sessionIds: readonly string[]): ReadonlySet<string> {
  if (!sessionIds.length) return ids;
  const known = new Set(sessionIds);
  const kept = [...ids].filter((id) => known.has(id));
  return kept.length === ids.size ? ids : new Set(kept);
}

export function withUnread(ids: ReadonlySet<string>, sessionId: string, unread: boolean): Set<string> | null {
  if (ids.has(sessionId) === unread) return null;
  const next = new Set(ids);
  if (unread) next.add(sessionId);
  else next.delete(sessionId);
  return next;
}
