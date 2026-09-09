import { ChevronLeft, ChevronRight, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import {
  reportedTokens,
  type ModelCallRecord,
  type ModelCallsPage,
  type ExecutionEventsPage,
} from "../modelDiagnostics";
import { ExecutionEvent } from "./ExecutionEvent";
import type { RpcClient } from "../rpc";
import type { HistoryCursor } from "../types";
import "./ModelDiagnostics.css";

type Props = {
  client: RpcClient;
  sessionId: string;
  agentId?: string;
  onClose: () => void;
};

export function ModelDiagnostics(props: Props) {
  return (
    <DiagnosticsDialog
      key={JSON.stringify([props.sessionId, props.agentId])}
      {...props}
    />
  );
}

function DiagnosticsDialog({ client, sessionId, agentId, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [view, setView] = useState<"calls" | "events">("calls");
  const [page, setPage] = useState<ModelCallsPage | ExecutionEventsPage | null>(
    null,
  );
  const [cursors, setCursors] = useState<Array<HistoryCursor | null>>([null]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cursor = cursors[cursors.length - 1];

  const reload = useCallback(async () => {
    request.current?.abort();
    const pending = new AbortController();
    request.current = pending;
    setLoading(true);
    try {
      const result = await client.call<ModelCallsPage | ExecutionEventsPage>(
        view === "calls" ? "session.modelCalls" : "session.executionEvents",
        {
          sessionId,
          ...(agentId ? { agentId } : {}),
          before: cursor,
          limit: 20,
        },
        { signal: pending.signal },
      );
      if (pending.signal.aborted) return;
      setPage(result);
      setError(null);
    } catch (cause) {
      if (!pending.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!pending.signal.aborted) {
        setLoading(false);
        request.current = null;
      }
    }
  }, [client, sessionId, agentId, cursor, view]);

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  useEffect(() => {
    setPage(null);
    setError(null);
    void reload();
    return () => {
      request.current?.abort();
    };
  }, [reload]);
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden && !request.current) void reload();
    };
    const stop = client.onStatus((connected) => {
      if (connected) refresh();
    });
    window.addEventListener("focus", refresh);
    return () => {
      stop();
      window.removeEventListener("focus", refresh);
    };
  }, [client, reload]);

  return (
    <dialog
      ref={dialog}
      className="model-diagnostics"
      aria-labelledby="model-diagnostics-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2 id="model-diagnostics-title">模型调用记录</h2>
        <button
          type="button"
          className="icon-button"
          title="刷新调用记录"
          aria-label="刷新调用记录"
          disabled={loading}
          onClick={() => void reload()}
        >
          <RefreshCw size={17} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="关闭调用记录"
          aria-label="关闭调用记录"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <nav className="diagnostics-tabs" aria-label="诊断视图">
        {(["calls", "events"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={view === value}
            onClick={() => {
              if (view !== value) {
                setPage(null);
                setCursors([null]);
                setView(value);
              }
            }}
          >
            {value === "calls" ? "模型调用" : "执行事件"}
          </button>
        ))}
      </nav>
      <div className="model-diagnostics-body" aria-busy={loading}>
        {error && <p role="alert">{error}</p>}
        {loading && !page && <p role="status">正在读取调用记录</p>}
        {page && "calls" in page && page.calls.length === 0 && (
          <p>暂无调用记录</p>
        )}
        {page &&
          "calls" in page &&
          page.calls.map((call) => <CallRecord key={call.id} call={call} />)}
        {page && "events" in page && page.events.length === 0 && (
          <p>暂无执行事件</p>
        )}
        {page &&
          "events" in page &&
          page.events.map((event) => (
            <ExecutionEvent key={event.id} event={event} />
          ))}
      </div>
      <footer>
        <button
          type="button"
          className="icon-button"
          title="较新的调用"
          aria-label="较新的调用"
          disabled={loading || cursors.length === 1}
          onClick={() => setCursors((current) => current.slice(0, -1))}
        >
          <ChevronLeft size={18} />
        </button>
        <span>第 {cursors.length} 页</span>
        <button
          type="button"
          className="icon-button"
          title="较早的调用"
          aria-label="较早的调用"
          disabled={loading || !page?.nextCursor}
          onClick={() => {
            if (page?.nextCursor)
              setCursors((current) => [...current, page.nextCursor]);
          }}
        >
          <ChevronRight size={18} />
        </button>
      </footer>
    </dialog>
  );
}

const status = {
  running: "执行中",
  completed: "完成",
  failed: "失败",
  interrupted: "已中断",
};
const purpose = {
  task: "任务",
  compaction: "上下文压缩",
  planReview: "计划核对",
  skillLearning: "技能提炼",
};
const amount = (value: number | null) =>
  value === null ? "未返回" : value.toLocaleString();

function CallRecord({ call }: { call: ModelCallRecord }) {
  const tokens = reportedTokens(call);
  return (
    <article className="model-call">
      <div className="model-call-heading">
        <strong>{call.request?.model ?? "未知模型"}</strong>
        <span data-status={call.status}>{status[call.status]}</span>
      </div>
      <div className="model-call-meta">
        <time dateTime={call.startedAt}>
          {new Date(call.startedAt).toLocaleString()}
        </time>
        <span>
          {purpose[call.trace.purpose]}
          {call.trace.step !== null ? ` · 步骤 ${call.trace.step}` : ""} · 第{" "}
          {call.trace.attempt} 次请求
        </span>
        <span>{call.agentId ? `子任务 ${call.agentId}` : "主任务"}</span>
      </div>
      <dl className="model-call-metrics">
        <div>
          <dt>协议 / 推理</dt>
          <dd>
            {call.request?.apiProtocol ?? "未知"} /{" "}
            {call.request?.reasoningEffort ?? "默认"}
          </dd>
        </div>
        <div>
          <dt>耗时</dt>
          <dd>
            {call.elapsedMs === null
              ? "未结束"
              : `${(call.elapsedMs / 1000).toFixed(1)} 秒`}
          </dd>
        </div>
        <div>
          <dt>发送的输出上限</dt>
          <dd>
            {call.request
              ? call.request.maxOutputTokens === null
                ? "未设置"
                : amount(call.request.maxOutputTokens)
              : "未知"}
          </dd>
        </div>
        <div>
          <dt>估算输入 tokens</dt>
          <dd>{amount(call.estimatedInputTokens)}</dd>
        </div>
        <div>
          <dt>返回输入 tokens</dt>
          <dd>{amount(tokens.input)}</dd>
        </div>
        <div>
          <dt>返回输出 tokens</dt>
          <dd>{amount(tokens.output)}</dd>
        </div>
        <div>
          <dt>其中推理 tokens</dt>
          <dd>{amount(tokens.reasoning)}</dd>
        </div>
        <div>
          <dt>停止原因</dt>
          <dd>{call.response.stopReason ?? "未返回"}</dd>
        </div>
      </dl>
      {call.error && <p className="model-call-error">{call.error}</p>}
      <details>
        <summary>调用详情</summary>
        <pre>{JSON.stringify(call, null, 2)}</pre>
      </details>
    </article>
  );
}
