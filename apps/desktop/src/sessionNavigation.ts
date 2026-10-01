import type { Session, Workspace } from "./types";
import { sidebarGroups } from "./components/SidebarNavigation";

/** Session ids in the order the sidebar shows them (unfiltered, archived excluded). */
export function sidebarSessionOrder(
  workspaces: readonly Workspace[],
  sessions: readonly Session[],
  unread: ReadonlySet<string> = new Set(),
): string[] {
  const { groups } = sidebarGroups(workspaces as Workspace[], sessions as Session[], unread, "", "all");
  return groups.flatMap((group) => group.sessions.map((session) => session.id));
}

/** Step through `order` from `current`, wrapping around. */
export function stepSession(order: readonly string[], current: string | null, delta: 1 | -1): string | null {
  if (order.length === 0) return null;
  const index = current ? order.indexOf(current) : -1;
  if (index < 0) return delta > 0 ? order[0] : order[order.length - 1];
  const next = order[(index + delta + order.length) % order.length];
  return next === current ? null : next;
}

/** Next session needing attention (waiting for approval or unread), after `current`. */
export function nextAttentionSession(
  order: readonly string[],
  current: string | null,
  sessions: readonly Session[],
  unread: ReadonlySet<string>,
): string | null {
  const status = new Map(sessions.map((session) => [session.id, session.status]));
  const needs = (id: string) => id !== current && (status.get(id) === "waiting_approval" || unread.has(id));
  const start = current ? order.indexOf(current) : -1;
  for (let offset = 1; offset <= order.length; offset += 1) {
    const id = order[(start + offset + order.length) % order.length];
    if (id && needs(id)) return id;
  }
  return null;
}

export interface SessionHistory {
  /** Visit history for back/forward. */
  entries: string[];
  index: number;
  /** Most recently used first. */
  mru: string[];
}

export const HISTORY_LIMIT = 100;

export const EMPTY_HISTORY: SessionHistory = { entries: [], index: -1, mru: [] };

/** Record a visit to `id`. Navigating to the current entry is a no-op. */
export function visitSession(history: SessionHistory, id: string): SessionHistory {
  const mru = [id, ...history.mru.filter((entry) => entry !== id)].slice(0, HISTORY_LIMIT);
  if (history.entries[history.index] === id) {
    return mru[0] === history.mru[0] && mru.length === history.mru.length ? history : { ...history, mru };
  }
  const entries = [...history.entries.slice(0, history.index + 1), id].slice(-HISTORY_LIMIT);
  return { entries, index: entries.length - 1, mru };
}

/**
 * Move back (-1) or forward (+1), skipping sessions that no longer exist.
 * Returns the new history and target, or null when there is nowhere to go.
 */
export function moveHistory(
  history: SessionHistory,
  delta: 1 | -1,
  exists: (id: string) => boolean = () => true,
): { history: SessionHistory; target: string } | null {
  const current = history.entries[history.index];
  for (let index = history.index + delta; index >= 0 && index < history.entries.length; index += delta) {
    const target = history.entries[index];
    if (target !== current && exists(target)) {
      const mru = [target, ...history.mru.filter((entry) => entry !== target)];
      return { history: { ...history, index, mru }, target };
    }
  }
  return null;
}

/**
 * Ctrl+Tab target: the previously used session (+1) or the least recently
 * used one (-1), skipping sessions that no longer exist.
 */
export function recentSession(
  history: SessionHistory,
  current: string | null,
  delta: 1 | -1,
  exists: (id: string) => boolean = () => true,
): string | null {
  const candidates = history.mru.filter((id) => id !== current && exists(id));
  if (candidates.length === 0) return null;
  return delta > 0 ? candidates[0] : candidates[candidates.length - 1];
}
