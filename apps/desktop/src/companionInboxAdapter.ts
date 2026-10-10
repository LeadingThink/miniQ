import { getAttentionItems, markRead, type AttentionItem } from "./companionInbox";
import type { Session, Workspace } from "./types";
import type { CompanionNotice } from "./components/companion/companionTask";

/** Shared persisted inbox; no notification hooks or native emit permission are needed. */
export function getLocalAttentionItems(): AttentionItem[] {
  const items: AttentionItem[] = [];
  let offset = 0;
  for (;;) {
    const page = getAttentionItems({ host: null, offset });
    items.push(...page.items);
    if (!page.hasMore) return items;
    offset += page.items.length;
  }
}

export function localCompanionNotices(items: readonly AttentionItem[], workspaces: readonly Workspace[], sessions: readonly Session[]): CompanionNotice[] {
  return items.flatMap((item) => {
    if (item.host !== null || item.targetDeviceId || item.state !== "unread") return [];
    const session = sessions.find((entry) => entry.id === item.sessionId);
    if (!session || session.external || session.archived || (item.workspaceId && item.workspaceId !== session.workspaceId)
      || !workspaces.some((entry) => entry.id === session.workspaceId)) return [];
    return [{ id: item.id, sessionId: session.id, workspaceId: session.workspaceId,
      state: item.kind === "failed" ? "failed" : item.kind === "approval" || item.kind === "question" ? "needs_input" : "ready",
      text: item.detail || item.title } satisfies CompanionNotice];
  });
}

export function markLocalNoticeRead(id: string): void {
  const item = getLocalAttentionItems().find((entry) => entry.id === id && !entry.targetDeviceId);
  if (!item) throw new Error("伙伴提醒不是有效的本机提醒");
  const changed = markRead(id);
  if (!changed.ok) throw new Error(changed.error ?? "伙伴提醒无法标为已读");
}
