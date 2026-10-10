import { Check, Download, MessageCircleQuestion, ShieldCheck, ShieldX } from "lucide-react";
import { formatDuration } from "../time";
import type { ShareEvent, SharedMessage, ShareSummary } from "../sharing";
import { MINIQ_DOWNLOAD_URL } from "../sharing";

const EFFORT_LABELS: Record<string, string> = {
  none: "关闭推理", minimal: "最少推理", low: "低推理", medium: "中推理",
  high: "高推理", xhigh: "超高推理", max: "最大推理", ultra: "极致推理",
};

export function modelLabel(model: string, effort?: string | null) {
  return effort ? `${model} · ${EFFORT_LABELS[effort] ?? effort}` : `${model} · 默认推理`;
}

export function DownloadLink({ className, children }: { className?: string; children: React.ReactNode }) {
  return <a className={className} href={MINIQ_DOWNLOAD_URL} target="_blank" rel="noreferrer">
    <Download size={15} aria-hidden="true" />{children}</a>;
}

export function ShareSummaryCards({ summary, fileCount }: { summary: ShareSummary; fileCount: number }) {
  const elapsed = summary.elapsedMs === null ? null : formatDuration(summary.elapsedMs);
  const stats: [string, string][] = [
    ["对话轮数", `${summary.turns} 轮`],
    ...(elapsed ? [["总用时", elapsed] as [string, string]] : []),
    ["用户确认", `${summary.confirmations} 次`],
    ["产出文件", `${fileCount} 个`],
  ];
  return <>
    <section className="shared-summary" aria-label="会话概览">
      {stats.map(([label, value]) => <div key={label}><small>{label}</small><strong>{value}</strong></div>)}
    </section>
    {summary.models.length > 0 && <div className="shared-models" aria-label="使用的模型">
      {summary.models.map((item) => <span key={`${item.model}:${item.effort}`} className="shared-chip">{modelLabel(item.model, item.effort)}</span>)}
    </div>}
  </>;
}

export function TurnHeader({ message }: { message: SharedMessage }) {
  const elapsed = message.elapsedMs === undefined ? null : formatDuration(message.elapsedMs);
  return <div className="shared-turn-head">
    <b>提问</b><span>{new Date(message.createdAt).toLocaleString()}</span>{elapsed && <span>用时 {elapsed}</span>}
  </div>;
}

export function ShareEvents({ events }: { events: ShareEvent[] }) {
  return <>{events.map((event, index) => event.type === "question"
    ? <div className="shared-ask" key={index}>
      <div className="shared-ask-head"><MessageCircleQuestion size={14} aria-hidden="true" />miniQ 提问</div>
      <div className="shared-ask-prompt">{event.prompt}</div>
      {(event.options?.length ?? 0) > 0
        ? <div className="shared-options">{event.options!.map((option) => <span key={option}
          className={option === event.answer ? "selected" : ""}>{option === event.answer && <Check size={13} aria-hidden="true" />}{option}</span>)}</div>
        : event.answer && <div className="shared-options"><span className="selected"><Check size={13} aria-hidden="true" />{event.answer}</span></div>}
    </div>
    : <div className={`shared-approval ${event.decision}`} key={index}>
      {event.decision === "rejected" ? <ShieldX size={14} aria-hidden="true" /> : <ShieldCheck size={14} aria-hidden="true" />}
      <b>{event.decision === "rejected" ? "已拒绝" : "已允许"}</b><code>{event.tool}</code>
    </div>)}</>;
}
