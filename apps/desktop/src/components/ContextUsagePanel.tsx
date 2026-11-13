import { RotateCw, X } from "lucide-react";
import {
  contextUsageLabels,
  formatContextTokens,
  type ContextUsage,
  type ContextUsageCategory,
} from "../contextUsage";

const categoryOrder: ContextUsageCategory["id"][] = [
  "system",
  "tools",
  "conversation",
  "connectors",
  "skills",
];

export function ContextUsagePanel(props: {
  usage: ContextUsage | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const percent = props.usage?.percentUsed ?? null;
  const warning = !!props.usage && props.usage.estimatedTokens >= props.usage.autoCompactTokens;
  const categories = props.usage?.categories ?? null;
  const tokens = (id: ContextUsageCategory["id"]) =>
    categories?.find(entry => entry.id === id)?.tokens ?? null;
  const actual = props.usage?.lastRequestActualTokens ?? null;

  return <>
    <header><strong>上下文用量</strong><button type="button" aria-label="关闭上下文用量" onClick={props.onClose}><X size={16} /></button></header>
    {props.error ? <><p role="alert">{props.error}</p><button type="button" onClick={props.onRefresh}>重试</button></> : <>
      <div className="context-usage-total"><strong>{percent === null ? "—" : `${Number(percent.toFixed(1))}%`}</strong>
        <span>{props.usage ? `估算已用 ${formatContextTokens(props.usage.estimatedTokens)} / ${props.usage.contextWindowTokens === null ? "容量未知" : formatContextTokens(props.usage.contextWindowTokens)} tokens` : "正在读取上下文…"}</span></div>
      <div className="context-usage-meter" role="meter" aria-label="估算上下文占比" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={percent ?? undefined} aria-valuetext={percent === null ? "容量未知" : `${percent.toFixed(1)}%`}>
        <span style={{ width: `${percent === null ? 0 : Math.min(100, Math.max(0, percent))}%` }} />
      </div>
      <ul>{categoryOrder.map((id, index) => {
        const value = tokens(id);
        return <li key={id}><i className={`context-category-${index}`} aria-hidden="true" />
          <span>{contextUsageLabels[id]}</span>
          <small>{value === null ? "未单独统计" : `${formatContextTokens(value)} tokens`}</small></li>;
      })}</ul>
      <p className="context-usage-note">按本轮请求估算的 token 数拆分，非计费 token。系统提示词与技能按提示词原文估算；工具与连接器按本轮实际下发的工具 schema 估算；对话消息为其余部分。</p>
      {props.usage && <dl><div><dt>模型上下文容量</dt><dd>{props.usage.contextWindowTokens === null ? "未知" : `${formatContextTokens(props.usage.contextWindowTokens)} tokens`}</dd></div>
        <div><dt>自动压缩阈值</dt><dd>{formatContextTokens(props.usage.autoCompactTokens)} tokens</dd></div>
        {props.usage.lastRequestTokens !== null && <div><dt>最近请求估算</dt><dd>{formatContextTokens(props.usage.lastRequestTokens)} tokens</dd></div>}
        <div><dt>模型接口实际输入</dt><dd>{actual === null ? "暂无请求记录" : `${formatContextTokens(actual)} tokens`}</dd></div></dl>}
      {warning && <p className="context-usage-warning">基础估算已达到自动压缩阈值，实际请求可能触发压缩。</p>}
      <footer><span>{props.loading ? "更新中…" : "容量由模型提供"}</span><button type="button" disabled={props.loading} onClick={props.onRefresh}><RotateCw size={13} />刷新</button></footer>
    </>}
  </>;
}
