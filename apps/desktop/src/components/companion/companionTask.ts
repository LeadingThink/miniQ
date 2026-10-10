import type { Session, Workspace } from "../../types";
import { errorMessage } from "../../errorMessage";

export type CompanionState = "idle" | "running" | "needs_input" | "failed" | "ready";
export const COMPANION_STATE_LABELS: Record<CompanionState, string> = {
  idle: "待命", running: "正在处理", needs_input: "需要你确认", failed: "任务遇到问题", ready: "已完成，等待你查看",
};
export type CompanionMethod = "workspace.list" | "session.list" | "session.create" | "session.sendMessage";
export interface CompanionRpc { call<T>(method: CompanionMethod, params?: unknown): Promise<T> }
/** Integration seam for companionInbox.ts; this module never owns notifications or sounds. */
export interface CompanionNotice {
  id: string;
  sessionId: string;
  workspaceId: string;
  state: CompanionState;
  text: string;
}

export function companionSessionState(session?: Session, needsInput = false): CompanionState {
  if (needsInput || session?.status === "waiting_approval") return "needs_input";
  if (session?.status === "running" || session?.status === "cancelling") return "running";
  if (session?.status === "failed") return "failed";
  return session && (session.turnCount ?? 0) > 0 ? "ready" : "idle";
}

export function mostRelevantSession(sessions: Session[]): Session | undefined {
  const priority = { needs_input: 4, failed: 3, running: 2, ready: 1, idle: 0 };
  return sessions.filter((s) => !s.archived).sort((a, b) => priority[companionSessionState(b)] - priority[companionSessionState(a)] || b.updatedAt.localeCompare(a.updatedAt))[0];
}

export interface TaskDraft { content: string; workspaceId: string; sessionId: string | null }
export type SendResult = { draft: TaskDraft; session?: Session; error?: string; sent: boolean };

/** Creating once and retaining its ID on send failure lets an explicit retry reuse the session. */
export async function sendCompanionTask(client: CompanionRpc, draft: TaskDraft, workspaces: Workspace[], sessions: Session[]): Promise<SendResult> {
  if (!draft.content.trim()) return { draft, sent: false, error: "请先输入任务" };
  const workspace = workspaces.find((w) => w.id === draft.workspaceId);
  if (!workspace) return { draft, sent: false, error: "请明确选择一个已授权的本机项目" };
  let session = draft.sessionId ? sessions.find((s) => s.id === draft.sessionId && s.workspaceId === workspace.id && !s.archived && !s.external) : undefined;
  if (draft.sessionId && !session) return { draft, sent: false, error: "会话不属于所选本机项目，请重新选择" };
  let retained = { ...draft };
  try {
    session ??= await client.call<Session>("session.create", { workspaceId: workspace.id });
    if (!session.id || session.workspaceId !== workspace.id) throw new Error("服务返回的会话与所选项目不匹配");
    retained = { ...draft, sessionId: session.id };
    await client.call("session.sendMessage", {
      sessionId: session.id, message: { role: "user", content: draft.content, attachments: [] }, rejectIfBusy: true,
    });
    return { draft: { ...retained, content: "" }, session, sent: true };
  } catch (error) {
    return { draft: retained, session, sent: false, error: errorMessage(error) };
  }
}
