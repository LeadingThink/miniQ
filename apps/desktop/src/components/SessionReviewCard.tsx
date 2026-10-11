import { useId, useRef, useState } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import type { ReviewRun } from "../sessionReview";

export const REVIEW_STATUS: Record<ReviewRun["status"], string> = {
  queued: "排队中", running: "检查中", completed: "检查完成",
  failed: "检查失败", cancelled: "已取消", stale: "报告已过期",
};
const SEVERITY = { suggestion: "建议", important: "重要", critical: "严重" };

function banner(run: ReviewRun): { tone: string; title: string; note?: string } {
  if (run.status === "queued" || run.status === "running")
    return { tone: "pending", title: `${REVIEW_STATUS[run.status]}…`, note: `${run.model} 正在独立检查` };
  if (run.status === "failed") return { tone: "danger", title: "检查失败", note: `${run.error ?? "未返回原因"}，不能视为检查通过` };
  if (run.status === "cancelled") return { tone: "muted", title: "已取消", note: "不能视为检查通过" };
  if (run.status === "stale") return { tone: "muted", title: "报告已过期", note: "原答复或证据已变化，请重新检查" };
  if (run.verdict === "issues_found")
    return { tone: "warn", title: run.findings.length ? `发现 ${run.findings.length} 个问题` : "发现需要核实的问题" };
  if (run.verdict === "insufficient_evidence") return { tone: "muted", title: "证据不足", note: "无法据此判断答复是否正确" };
  if (run.verdict === "no_material_issue_found") return { tone: "ok", title: "未发现明确问题", note: "不代表答复一定正确" };
  return { tone: "muted", title: "尚无结论", note: "不能视为检查通过" };
}

/** Report body for one review run: verdict banner, findings and collapsed evidence. */
export function SessionReviewCard({ run }: { run: ReviewRun }) {
  const prefix = useId();
  const items = useRef(new Map<string, HTMLDetailsElement>());
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const state = banner(run);
  const sourceCount = run.evidence.length + run.limitations.length;
  const showEvidence = (id: string) => {
    setSourcesOpen(true);
    setExpanded(id);
    // The disclosure renders its body on the next commit.
    requestAnimationFrame(() => {
      const target = items.current.get(id);
      target?.scrollIntoView?.({ block: "nearest" });
      target?.querySelector("summary")?.focus();
    });
  };

  return <article className="session-review-report" aria-label="第二意见报告">
    <div className={`session-review-banner tone-${state.tone}`} role="status">
      {state.tone === "pending" && <LoaderCircle className="spin" size={13} aria-hidden="true" />}
      <strong>{state.title}</strong>
      {state.note && <span>{state.note}</span>}
    </div>
    {run.error && run.status !== "failed" && <p className="session-review-note" role="alert">{run.error}</p>}
    {run.findings.length > 0 && <ol className="session-review-findings">
      {run.findings.map((finding, index) => <li key={index} className="session-review-finding">
        <div className="session-review-finding-head">
          <span className={`session-review-severity severity-${finding.severity}`}>{SEVERITY[finding.severity]}</span>
          <p className="session-review-claim">{finding.claim}</p>
        </div>
        {finding.recommendation && <p className="session-review-recommendation">{finding.recommendation}</p>}
        {finding.evidenceIds.length > 0 && <div className="session-review-evidence-chips">
          {finding.evidenceIds.map((id) => {
            const entry = run.evidence.find((candidate) => candidate.id === id);
            return entry
              ? <button key={id} type="button" className="session-review-evidence-chip"
                aria-controls={`${prefix}-sources`} onClick={() => showEvidence(id)}>证据：{entry.title || id}</button>
              : <span key={id} className="session-review-evidence-chip is-missing">证据 {id}（未提供）</span>;
          })}
        </div>}
      </li>)}
    </ol>}
    {(run.status === "completed" || sourceCount > 0) && <details
      id={`${prefix}-sources`}
      className="session-review-sources"
      open={sourcesOpen}
      onToggle={(event) => setSourcesOpen(event.currentTarget.open)}
    >
      <summary><ChevronRight size={12} aria-hidden="true" />本轮证据与局限 ({sourceCount})</summary>
      {sourcesOpen && <div className="session-review-sources-body">
        {run.limitations.length > 0 && <ul className="session-review-limitations">
          {run.limitations.map((text, index) => <li key={index}>{text}</li>)}
        </ul>}
        {!run.evidence.length && <p className="session-review-note">没有提供证据；不能据此确认答复正确。</p>}
        {run.evidence.map((entry) => <details
          key={entry.id}
          className="session-review-evidence"
          ref={(node) => { if (node) items.current.set(entry.id, node); else items.current.delete(entry.id); }}
          open={expanded === entry.id}
          onToggle={(event) => {
            if (event.currentTarget.open) setExpanded(entry.id);
            else setExpanded((current) => current === entry.id ? null : current);
          }}
        >
          <summary><span>{entry.title || entry.id}</span><span className="session-review-kind">{entry.kind}</span></summary>
          <pre>{entry.text}</pre>
        </details>)}
      </div>}
    </details>}
    {(run.inputTokens != null || run.outputTokens != null) && <small className="session-review-tokens">
      token 输入 {run.inputTokens ?? "—"} · 输出 {run.outputTokens ?? "—"}
    </small>}
  </article>;
}
