import { useCallback, useRef, useState } from "react";
import { RotateCw, X } from "lucide-react";
import type { RpcClient } from "../rpc";
import {
  contextUsageLabels,
  formatContextTokens,
  type ContextUsageCategory,
} from "../contextUsage";
import { useContextUsage } from "../hooks/useContextUsage";
import { Popover } from "./ui/Popover";
import "./ContextUsageControl.css";

const categoryOrder: ContextUsageCategory["id"][] = [
  "system",
  "tools",
  "conversation",
  "connectors",
  "skills",
];

export function ContextUsageControl({ client, sessionId }: { client: RpcClient; sessionId: string | null }) {
  const { usage, loading, error, refresh } = useContextUsage(client, sessionId);
  const [opened, setOpened] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => { setOpened(null); trigger.current?.focus(); }, []);
  const percent = usage?.percentUsed ?? null;
  const warning = !!usage && usage.estimatedTokens >= usage.autoCompactTokens;
  // Older daemons return no split; keep the labels and say the value is unknown
  // rather than inventing a number.
  const categories = usage?.categories ?? null;
  const tokens = (id: ContextUsageCategory["id"]) =>
    categories?.find(entry => entry.id === id)?.tokens ?? null;
  const actual = usage?.lastRequestActualTokens ?? null;
  return <>
    <button ref={trigger} type="button" className={`context-usage-trigger${warning ? " is-warning" : ""}`}
      aria-label="上下文用量" aria-haspopup="dialog" aria-expanded={opened !== null && opened === sessionId}
      disabled={!sessionId} title={percent === null ? "上下文用量：容量未知" : `上下文用量：${percent.toFixed(1)}%（估算）`}
      onClick={() => {
        if (opened === sessionId) close();
        else { setOpened(sessionId); void refresh(); }
      }}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="context-usage-track" cx="12" cy="12" r="9" />
        {percent !== null && <circle className="context-usage-fill" cx="12" cy="12" r="9" pathLength="100"
          strokeDasharray={`${Math.min(100, Math.max(0, percent))} 100`} />}
      </svg>
    </button>
    <Popover open={opened !== null && opened === sessionId} anchorRef={trigger} onClose={close}
      label="上下文用量" className="context-usage-popover" topLayer>
      <header><strong>上下文用量</strong><button type="button" aria-label="关闭上下文用量" onClick={close}><X size={16} /></button></header>
      {error ? <><p role="alert">{error}</p><button type="button" onClick={() => void refresh()}>重试</button></> : <>
        <div className="context-usage-total"><strong>{percent === null ? "—" : `${Number(percent.toFixed(1))}%`}</strong>
          <span>{usage ? `估算已用 ${formatContextTokens(usage.estimatedTokens)} / ${usage.contextWindowTokens === null ? "容量未知" : formatContextTokens(usage.contextWindowTokens)} tokens` : "正在读取上下文…"}</span></div>
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
        {usage && <dl><div><dt>模型上下文容量</dt><dd>{usage.contextWindowTokens === null ? "未知" : `${formatContextTokens(usage.contextWindowTokens)} tokens`}</dd></div>
          <div><dt>自动压缩阈值</dt><dd>{formatContextTokens(usage.autoCompactTokens)} tokens</dd></div>
          {usage.lastRequestTokens !== null && <div><dt>最近请求估算</dt><dd>{formatContextTokens(usage.lastRequestTokens)} tokens</dd></div>}
          <div><dt>模型接口实际输入</dt><dd>{actual === null ? "暂无请求记录" : `${formatContextTokens(actual)} tokens`}</dd></div></dl>}
        {warning && <p className="context-usage-warning">基础估算已达到自动压缩阈值，实际请求可能触发压缩。</p>}
        <footer><span>{loading ? "更新中…" : "容量由模型提供"}</span><button type="button" disabled={loading} onClick={() => void refresh()}><RotateCw size={13} />刷新</button></footer>
      </>}
    </Popover>
  </>;
}
