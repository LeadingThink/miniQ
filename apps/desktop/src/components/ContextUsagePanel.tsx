import { RotateCw, X } from "lucide-react";
import {
  contextUsageLabels,
  formatCompactContextTokens,
  formatContextPercent,
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

function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, percent));
}

function UsageDetails({ usage }: { usage: ContextUsage }) {
  const capacity = usage.contextWindowTokens;
  const warning = usage.estimatedTokens >= usage.autoCompactTokens;
  const actual = usage.lastRequestActualTokens ?? null;
  // Share of the model window when it is known; otherwise the raw estimate.
  const share = (tokens: number) =>
    capacity ? formatContextPercent((tokens / capacity) * 100) : formatCompactContextTokens(tokens);

  return <>
    <p className={warning ? "context-usage-warning" : "context-usage-legend"}>
      {warning
        ? "基础估算已达到自动压缩阈值，实际请求可能触发压缩。"
        : `达到 ${formatCompactContextTokens(usage.autoCompactTokens)} 时自动压缩`}
    </p>
    <h3>估算构成</h3>
    <ul>{categoryOrder.map((id) => {
      const tokens = usage.categories?.find(entry => entry.id === id)?.tokens ?? null;
      return <li key={id}>
        <span>{contextUsageLabels[id]}</span>
        {tokens === null
          ? <small>未单独统计</small>
          : <small title={`${formatContextTokens(tokens)} tokens`}>{share(tokens)}</small>}
      </li>;
    })}</ul>
    <h3>最近请求</h3>
    <dl>
      {usage.lastRequestTokens !== null && <div><dt>本地估算</dt><dd>{formatContextTokens(usage.lastRequestTokens)}</dd></div>}
      <div><dt>模型接口实际输入</dt><dd>{actual === null ? "暂无请求记录" : formatContextTokens(actual)}</dd></div>
    </dl>
  </>;
}

export function ContextUsagePanel(props: {
  usage: ContextUsage | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const { usage } = props;
  const percent = usage?.percentUsed ?? null;
  const capacity = usage?.contextWindowTokens ?? null;

  return <>
    <header>
      <strong>上下文用量</strong>
      <span className="context-usage-actions">
        {!props.error && <button type="button" aria-label="刷新上下文用量" title="刷新" disabled={props.loading}
          className={props.loading ? "is-loading" : undefined} onClick={props.onRefresh}><RotateCw size={14} /></button>}
        <button type="button" aria-label="关闭上下文用量" title="关闭" onClick={props.onClose}><X size={15} /></button>
      </span>
    </header>
    {props.error ? <>
      <p role="alert">{props.error}</p>
      <button type="button" className="context-usage-retry" onClick={props.onRefresh}>重试</button>
    </> : <>
      <div className="context-usage-total">
        <span title={usage ? `估算已用 ${formatContextTokens(usage.estimatedTokens)} tokens` : undefined}>
          {usage
            ? `${formatCompactContextTokens(usage.estimatedTokens)} / ${capacity === null ? "容量未知" : formatCompactContextTokens(capacity)} tokens`
            : "正在读取上下文…"}
        </span>
        <strong>{percent === null ? "—" : formatContextPercent(percent)}</strong>
      </div>
      <div className="context-usage-meter" role="meter" aria-label="估算上下文占比" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={percent ?? undefined} aria-valuetext={percent === null ? "容量未知" : formatContextPercent(percent)}>
        <span style={{ width: `${percent === null ? 0 : clampPercent(percent)}%` }} />
        {usage && capacity ? <i aria-hidden="true" style={{ left: `${clampPercent((usage.autoCompactTokens / capacity) * 100)}%` }} /> : null}
      </div>
      {usage && <UsageDetails usage={usage} />}
    </>}
  </>;
}
