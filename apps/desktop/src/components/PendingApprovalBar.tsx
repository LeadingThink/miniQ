import { ChevronRight, ShieldQuestion } from "lucide-react";
import type { PendingApproval } from "../hooks/useSessionFeed";
import "./PendingApprovalBar.css";

/** Pinned above the composer so a pending approval stays visible however long
 * the transcript is. The full card with parameters remains in the timeline. */
export function PendingApprovalBar({ approvals, onResolve, onShowDetails }: {
  approvals: PendingApproval[];
  onResolve: (approvalId: string, decision: string) => void;
  onShowDetails: (approvalId: string) => void;
}) {
  const item = approvals[0];
  if (!item) return null;
  const id = item.approval.id;
  const more = approvals.length - 1;
  return (
    <section className="pending-approval-bar" role="region" aria-label="待审批操作">
      <div className="pending-approval-summary">
        <ShieldQuestion size={15} aria-hidden="true" />
        <strong>需要审批</strong>
        <span className="pending-approval-tool">{item.toolName}</span>
        <span className={`badge ${item.approval.riskLevel}`}>{item.approval.riskLevel}</span>
        {more > 0 && <span className="pending-approval-more">还有 {more} 项</span>}
      </div>
      {item.approval.reason && <p className="pending-approval-reason">{item.approval.reason}</p>}
      <div className="pending-approval-actions">
        <button type="button" onClick={() => onResolve(id, "approve")}>允许一次</button>
        <button type="button" className="secondary" onClick={() => onResolve(id, "approve_for_session")}>本会话允许</button>
        <button type="button" className="danger" onClick={() => onResolve(id, "reject")}>拒绝</button>
        <button type="button" className="ghost pending-approval-details" onClick={() => onShowDetails(id)}>
          查看参数<ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
