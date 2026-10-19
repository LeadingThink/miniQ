import type { RpcClient } from "./rpc";
import type { Session } from "./types";

export const SIDE_CONVERSATION_IDLE_MS = 15 * 60 * 1000;

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

export function sideConversationContext(state: SideConversationState, workspaceId: string, sourceSessionId: string | null) {
  return {
    workspaceId,
    sourceSessionId,
    sideConversationId: state.sessionId,
  };
}

export async function releaseSideConversation(client: Pick<RpcClient, "call">, state: SideConversationState): Promise<SideConversationState> {
  if (state.sessionId) await client.call("session.delete", { sessionId: state.sessionId });
  return EMPTY_SIDE_CONVERSATION;
}

export function createSideConversationState(session: Session, sourceSessionId: string | null, now = Date.now()): SideConversationState {
  return { sessionId: session.id, workspaceId: session.workspaceId, sourceSessionId, lastActivityAt: now };
}