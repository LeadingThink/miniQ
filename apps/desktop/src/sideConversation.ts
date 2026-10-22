import type { RpcClient } from "./rpc";
import type { Session } from "./types";

/** Side chats survive context switches and panel closes; only an explicit delete or
 *  three idle hours ends them. */
export const SIDE_CONVERSATION_IDLE_MS = 3 * 60 * 60 * 1000;

const SIDE_CONVERSATION_STORAGE_PREFIX = "miniq.sideConversation.";

export interface SideConversationState {
  sessionId: string | null;
  workspaceId: string | null;
  sourceSessionId: string | null;
  lastActivityAt: number;
}

export const EMPTY_SIDE_CONVERSATION: SideConversationState = {
  sessionId: null,
  workspaceId: null,
  sourceSessionId: null,
  lastActivityAt: 0,
};

export function isSideConversationExpired(state: SideConversationState, now: number, idleMs = SIDE_CONVERSATION_IDLE_MS): boolean {
  return Boolean(state.sessionId) && now - state.lastActivityAt >= idleMs;
}

export async function releaseSideConversation(
  client: Pick<RpcClient, "call">,
  state: SideConversationState,
  options: { cancel?: boolean } = {},
): Promise<SideConversationState> {
  if (state.sessionId) {
    if (options.cancel) {
      try {
        await client.call("session.cancel", { sessionId: state.sessionId });
      } catch {
        // The turn may have completed between the click and the cancel.
      }
    }
    await client.call("session.delete", { sessionId: state.sessionId });
  }
  return EMPTY_SIDE_CONVERSATION;
}

export function createSideConversationState(session: Session, sourceSessionId: string | null, now = Date.now()): SideConversationState {
  return { sessionId: session.id, workspaceId: session.workspaceId, sourceSessionId, lastActivityAt: now };
}

/** Persisted per connection and host so a reload or app restart resumes the same side chat. */
export function sideConversationStorageKey(host: string | null | undefined): string {
  return `${SIDE_CONVERSATION_STORAGE_PREFIX}${host ?? "local"}`;
}

export function readStoredSideConversation(key: string): SideConversationState | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SideConversationState>;
    if (typeof parsed.sessionId !== "string" || !parsed.sessionId) return null;
    return {
      sessionId: parsed.sessionId,
      workspaceId: typeof parsed.workspaceId === "string" ? parsed.workspaceId : null,
      sourceSessionId: typeof parsed.sourceSessionId === "string" ? parsed.sourceSessionId : null,
      lastActivityAt: Number.isFinite(parsed.lastActivityAt) ? Number(parsed.lastActivityAt) : 0,
    };
  } catch {
    return null;
  }
}

export function storeSideConversation(key: string, state: SideConversationState): void {
  if (typeof localStorage === "undefined" || !state.sessionId) return;
  try {
    localStorage.setItem(key, JSON.stringify(state));
  } catch {
    // A full or blocked storage keeps the live conversation; it just will not resume.
  }
}

export function clearStoredSideConversation(key: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignore storage failures.
  }
}