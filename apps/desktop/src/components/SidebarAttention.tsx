import { AlertCircle, ChevronDown, Clock3 } from "lucide-react";
import { useMemo, useState } from "react";
import type { Session } from "../types";

export interface SidebarAttentionProps {
  sessions: Session[];
  unreadSessionIds: ReadonlySet<string>;
  workspaceLabels: ReadonlyMap<string, string>;
  onSelectSession: (sessionId: string) => void;
  onClose?: () => void;
}

type AttentionKind = "waiting" | "failed" | "unread";
const kindLabel: Record<AttentionKind, string> = { waiting: "等待审批", failed: "失败", unread: "未读" };
const kindOrder: Record<AttentionKind, number> = { waiting: 0, failed: 1, unread: 2 };

function kindFor(session: Session, unread: ReadonlySet<string>): AttentionKind | null {
  if (session.archived) return null;
  if (session.status === "waiting_approval") return "waiting";
  if (session.status === "failed") return "failed";
  return unread.has(session.id) ? "unread" : null;
}

export function SidebarAttention({ sessions, unreadSessionIds, workspaceLabels, onSelectSession, onClose }: SidebarAttentionProps) {
  const [expanded, setExpanded] = useState(false);
  const items = useMemo(() => sessions
    .map((session) => ({ session, kind: kindFor(session, unreadSessionIds) }))
    .filter((item): item is { session: Session; kind: AttentionKind } => item.kind !== null)
    .sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || b.session.updatedAt.localeCompare(a.session.updatedAt)),
  [sessions, unreadSessionIds]);

  if (items.length === 0) return null;
  const select = (sessionId: string) => { onSelectSession(sessionId); onClose?.(); };
  return (
    <section className="sidebar-attention" aria-labelledby="sidebar-attention-heading">
      <button type="button" className="sidebar-attention-summary" aria-controls="sidebar-attention-list" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
        <span className="sidebar-attention-title"><AlertCircle size={15} aria-hidden="true" /><span id="sidebar-attention-heading">待处理</span><strong aria-label={`${items.length} 条待处理`}>{items.length}</strong></span>
        <span className="sidebar-attention-priority">{items.some((item) => item.kind === "waiting") ? "有待审批" : "需要查看"}</span>
        <ChevronDown className="sidebar-attention-chevron" size={15} aria-hidden="true" />
      </button>
      {expanded && <div id="sidebar-attention-list" className="sidebar-attention-list" role="list" aria-label="待处理会话">
        {items.map(({ session, kind }) => <div role="listitem" key={session.id}><button type="button" className={`sidebar-attention-item ${kind}`} onClick={() => select(session.id)} title={session.title}>
          <span className="sidebar-attention-item-icon" aria-hidden="true">{kind === "waiting" ? <Clock3 size={14} /> : <AlertCircle size={14} />}</span>
          <span className="sidebar-attention-item-copy"><span className="sidebar-attention-item-title">{session.title}</span><span className="sidebar-attention-item-context">{workspaceLabels.get(session.workspaceId) ?? "未命名项目"}</span></span>
          <span className="sidebar-attention-item-kind">{kindLabel[kind]}</span>
        </button></div>)}
      </div>}
    </section>
  );
}
