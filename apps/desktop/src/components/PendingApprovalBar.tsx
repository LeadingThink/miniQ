import { useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { PendingApproval } from "../hooks/useSessionFeed";
import { errorMessage } from "../errorMessage";
import { ApprovalCard } from "./TimelineInteractions";
import "./PendingApprovalBar.css";

/** The session's only approval action surface. Parameters and decisions share
 * one pinned panel; queued requests stay addressable without duplicating cards. */
export function PendingApprovalBar({ approvals, onResolve }: {
  approvals: PendingApproval[];
  onResolve: (approvalId: string, decision: string) => void | Promise<void>;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const index = Math.max(0, approvals.findIndex(item => item.approval.id === selected));
  const item = approvals[index];
  if (!item) return null;
  return <section className="pending-approval-bar" aria-label="待审批操作">
    {approvals.length > 1 && <nav className="pending-approval-queue" aria-label="待审批队列">
      <span>第 {index + 1} / {approvals.length} 项</span>
      <button type="button" className="icon-button" aria-label="上一项审批" disabled={index === 0}
        onClick={() => setSelected(approvals[index - 1].approval.id)}><ChevronLeft size={16} /></button>
      <button type="button" className="icon-button" aria-label="下一项审批" disabled={index === approvals.length - 1}
        onClick={() => setSelected(approvals[index + 1].approval.id)}><ChevronRight size={16} /></button>
    </nav>}
    <ApprovalDecision key={item.approval.id} item={item} onResolve={onResolve} />
  </section>;
}

function ApprovalDecision({ item, onResolve }: {
  item: PendingApproval;
  onResolve: (approvalId: string, decision: string) => void | Promise<void>;
}) {
  const sending = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolve = async (id: string, decision: string) => {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setError(null);
    try { await onResolve(id, decision); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { sending.current = false; setPending(false); }
  };
  return <>
    <ApprovalCard item={item} pending={pending} onResolve={(id, decision) => void resolve(id, decision)} />
    {error && <p role="alert">{error}</p>}
  </>;
}
