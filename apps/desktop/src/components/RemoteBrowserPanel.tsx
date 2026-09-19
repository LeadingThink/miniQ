import { useMemo, useState } from "react";
import { Globe2, X } from "lucide-react";
import type { RpcClient } from "../rpc";
import type { ToolCall } from "../types";
import { useToolDetail } from "../hooks/useToolDetail";
import { observationImage } from "../computerObservation";
import { ComputerObservation } from "./ComputerObservation";
import "./RemoteBrowserPanel.css";

function recordLabel(call: ToolCall): string {
  const input = call.input as { action?: string; url?: string } | null;
  return `${new Date(call.createdAt).toLocaleString()} · ${input?.action ?? "网页操作"}${input?.url ? ` · ${input.url}` : ""}`;
}

function BrowserRecord({ client, call, onDiscuss }: {
  client: RpcClient; call: ToolCall; onDiscuss: (content: string) => void;
}) {
  const detail = useToolDetail(client, call, true);
  const [showDetails, setShowDetails] = useState(false);
  const output = detail.call.output as Record<string, unknown> | null;
  const input = detail.call.input as Record<string, unknown> | null;
  const url = typeof output?.url === "string" ? output.url : typeof input?.url === "string" ? input.url : "";
  const title = typeof output?.title === "string" ? output.title : "网页观察";
  if (detail.loading) return <p role="status">正在加载所选网页记录…</p>;
  if (detail.error) return <div role="alert">{detail.error}<button type="button" onClick={detail.retry}>重新加载记录</button></div>;
  return <section className="remote-browser-record">
    <strong>{title}</strong>
    {url && <p className="remote-browser-url">{url}</p>}
    <time dateTime={call.createdAt}>{new Date(call.createdAt).toLocaleString()}</time>
    {observationImage(detail.call)
      ? <ComputerObservation client={client} call={detail.call} />
      : <p>这次操作没有保存截图，可展开查看记录，或请桌面任务重新观察网页。</p>}
    <button type="button" className="ghost" onClick={() => onDiscuss(`关于桌面网页「${title}」${url ? `（${url}）` : ""}，请先确认当前页面状态，再继续：\n`)}>继续操作这页</button>
    <details onToggle={(event) => setShowDetails(event.currentTarget.open)}>
      <summary>操作记录详情</summary>
      {showDetails && <pre>{JSON.stringify(detail.call.output ?? { status: call.status }, null, 2)}</pre>}
    </details>
  </section>;
}

export function RemoteBrowserPanel(props: {
  client: RpcClient; sessionId: string; calls: ToolCall[];
  hasOlder: boolean; loadingOlder: boolean; onLoadOlder: () => void;
  onClose: () => void; onDiscuss: (content: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const records = useMemo(() => props.calls.filter((call) => call.sessionId === props.sessionId &&
    call.toolName === "browser_automation" && (call.status === "succeeded" || call.status === "failed"))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [props.calls, props.sessionId]);
  const selected = records.find((call) => call.id === selectedId) ?? records[0];
  return <aside className="remote-browser-panel" aria-label="桌面网页记录">
    <header><Globe2 size={18} /><strong>桌面网页记录</strong>
      <button type="button" aria-label="关闭桌面网页记录" onClick={props.onClose}><X size={20} /></button>
    </header>
    <p className="remote-browser-note">这里展示任务保存的网页观察，并非实时画面。记录保留电脑当时的页面状态；在本机打开链接不会共享电脑的登录状态。</p>
    {records.length > 0 && <label className="remote-browser-selection">查看记录
      <select aria-label="选择网页记录" value={selected?.id} onChange={(event) => setSelectedId(event.target.value)}>
        {records.map((call) => <option key={call.id} value={call.id}>{recordLabel(call)}</option>)}
      </select>
    </label>}
    <div className="remote-browser-content">
      {selected ? <BrowserRecord key={`${props.sessionId}:${selected.id}`} client={props.client} call={selected} onDiscuss={props.onDiscuss} />
        : <p>当前已加载的会话内容中暂无网页记录。可以加载更早记录，或在聊天中让 miniQ 打开并观察网页。</p>}
      {props.hasOlder && <button type="button" className="ghost" disabled={props.loadingOlder} onClick={props.onLoadOlder}>{props.loadingOlder ? "正在加载…" : "加载更早记录"}</button>}
    </div>
  </aside>;
}
