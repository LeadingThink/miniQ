import { useId, useRef, useState } from "react";
import type { ReviewRun } from "../sessionReview";

export const REVIEW_STATUS: Record<ReviewRun["status"], string> = {
  queued: "排队中", running: "检查中", completed: "检查完成",
  failed: "检查失败", cancelled: "已取消", stale: "报告已过期",
};
const VERDICT = {
  no_material_issue_found: "未发现明确问题（不代表答复正确）",
  issues_found: "发现需要核实的问题",
  insufficient_evidence: "证据不足，无法判断",
};
const SEVERITY = { suggestion: "建议", important: "重要", critical: "严重" };

export function SessionReviewCard({ run }: { run: ReviewRun }) {
  const prefix = useId();
  const details = useRef(new Map<string, HTMLDetailsElement>());
  const [expanded, setExpanded] = useState<string | null>(null);
  return <article className="session-review-card" aria-label="第二意见报告">
    <header>
      <strong>{REVIEW_STATUS[run.status]}</strong>
      <span>审查模型：{run.model}</span>
    </header>
    <p role="status">{run.verdict ? VERDICT[run.verdict] : "尚无结论"}</p>
    {run.status !== "completed" && <p>此状态不能视为检查通过。{run.status === "stale" && "原答复或证据已变化，请重新检查。"}</p>}
    {run.error && <p role="alert">{run.error}</p>}
    {run.findings.map((finding, index) => <section className="session-review-finding" key={index}>
      <span className={`session-review-severity severity-${finding.severity}`}>{SEVERITY[finding.severity]}</span>
      <p>{finding.claim}</p>
      <p>建议：{finding.recommendation}</p>
      <div className="session-review-evidence-links">
        {finding.evidenceIds.map((id) => {
          const evidenceIndex = run.evidence.findIndex((entry) => entry.id === id);
          return evidenceIndex < 0 ? <span key={id}>证据 {id}（未提供）</span> : <a
            key={id}
            href={`#${prefix}-evidence-${evidenceIndex}`}
            onClick={(event) => {
              event.preventDefault();
              const target = details.current.get(id);
              if (target) {
                target.open = true;
                setExpanded(id);
                target.scrollIntoView?.({ block: "nearest" });
                target.querySelector("summary")?.focus();
              }
            }}
          >证据：{run.evidence[evidenceIndex].title || id}</a>;
        })}
      </div>
    </section>)}
    {run.limitations.length > 0 && <section><h3>局限</h3><ul>{run.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul></section>}
    <section>
      <h3>本轮证据</h3>
      {!run.evidence.length && <p>没有提供证据；不能据此确认答复正确。</p>}
      {run.evidence.map((entry, index) => <details
        key={entry.id}
        id={`${prefix}-evidence-${index}`}
        ref={(node) => { if (node) details.current.set(entry.id, node); else details.current.delete(entry.id); }}
        open={expanded === entry.id}
        onToggle={(event) => {
          if (event.currentTarget.open) setExpanded(entry.id);
          else setExpanded((current) => current === entry.id ? null : current);
        }}
      >
        <summary>{entry.title || entry.id} · {entry.kind}</summary>
        <pre>{entry.text}</pre>
      </details>)}
    </section>
    <small>输入 token：{run.inputTokens ?? "未提供"} · 输出 token：{run.outputTokens ?? "未提供"}</small>
  </article>;
}
