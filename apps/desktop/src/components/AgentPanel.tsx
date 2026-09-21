import {
  Activity,
  ChevronRight,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Search,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { RpcClient } from "../rpc";
import { ToolPayload } from "./ToolPayload";
import { RetryNotice } from "./RetryNotice";
import { ModelDiagnostics } from "./ModelDiagnostics";
import { AgentActivity } from "./AgentActivity";
import { AgentHistory } from "./AgentHistory";
import { AgentSummaryStats, type AgentSummary } from "./AgentSummary";
import { conversationTimestamp, formatDuration } from "../time";
import { turnProgressLabel } from "./ExecutionActivity";

const ACTIVE = new Set(["running", "stopping", "finalizing"]);
const LABELS: Record<string, string> = {
  running: "执行中",
  stopping: "正在停止",
  finalizing: "正在收尾",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

export function AgentPanel(props: {
  client: RpcClient;
  sessionId: string;
  busy: boolean;
}) {
  return <SessionAgentPanel key={props.sessionId} {...props} />;
}

function SessionAgentPanel({
  client,
  sessionId,
  busy,
}: {
  client: RpcClient;
  sessionId: string;
  busy: boolean;
}) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<AgentSummary | null>(null);
  const [pending, setPending] = useState(false);
  const [resultError, setResultError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<string | null>(null);
  const stoppingRef = useRef(false);
  const [filter, setFilter] = useState<"all" | "active" | "failed">("all");
  const [query, setQuery] = useState("");
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [activity, setActivity] = useState(false);
  const [history, setHistory] = useState(false);
  const actionEpoch = useRef(0);
  const detailsId = useId();

  useEffect(() => {
    let stale = false;
    let inFlight = false;
    let refreshQueued = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (delay: number) => {
      if (stale || document.visibilityState === "hidden") return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void refresh();
      }, delay);
    };
    const refresh = async () => {
      if (stale) return;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (inFlight) {
        refreshQueued = true;
        return;
      }
      if (document.visibilityState === "hidden") {
        return;
      }
      inFlight = true;
      let nextDelay: number | null = null;
      try {
        const response = await client.call<{ agents: AgentSummary[] }>(
          "agent.list",
          { sessionId },
        );
        if (stale) return;
        setAgents(response.agents);
        setError(null);
        if (busy || response.agents.some((agent) => ACTIVE.has(agent.status)))
          nextDelay = 2500;
      } catch (cause) {
        if (!stale) {
          setError(String(cause));
          // A temporary disconnect must not permanently freeze the panel,
          // including when the first request fails before any agents exist.
          nextDelay = 5000;
        }
      } finally {
        inFlight = false;
        if (stale) return;
        if (refreshQueued) {
          refreshQueued = false;
          schedule(0);
        } else if (nextDelay !== null) {
          schedule(nextDelay);
        }
      }
    };
    void refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh();
      else if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    const reconnect = client.onStatus((connected) => {
      if (connected && !stale) {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        void refresh();
      }
    });
    return () => {
      stale = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      reconnect();
    };
  }, [client, sessionId, busy, attempt]);

  useEffect(
    () => () => {
      actionEpoch.current++;
    },
    [sessionId],
  );

  const loadOutput = useCallback(
    async (agentId: string) => {
      const epoch = ++actionEpoch.current;
      setPending(true);
      setResultError(null);
      try {
        const value = await client.call<AgentSummary>("agent.output", {
          sessionId,
          agentId,
        });
        if (epoch !== actionEpoch.current) return;
        setResult(value);
      } catch (cause) {
        if (epoch === actionEpoch.current) setResultError(String(cause));
      } finally {
        if (epoch === actionEpoch.current) setPending(false);
      }
    },
    [client, sessionId],
  );

  const select = (agentId: string) => {
    actionEpoch.current++;
    setResult(null);
    setResultError(null);
    setPending(false);
    setActivity(false);
    setHistory(false);
    setSelected(selected === agentId ? null : agentId);
  };
  const selectedStatus = agents.find(
    (agent) => agent.agentId === selected,
  )?.status;
  useEffect(() => {
    if (selected) void loadOutput(selected);
    return () => {
      actionEpoch.current++;
    };
    // Refresh only when selection or durable status changes, not on each list poll.
  }, [selected, selectedStatus, loadOutput]);

  const stopAgent = async (agentId: string) => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(agentId);
    try {
      await client.call("agent.stop", { sessionId, agentId });
      setAttempt((value) => value + 1);
    } catch (cause) {
      setError(String(cause));
    } finally {
      stoppingRef.current = false;
      setStopping(null);
    }
  };

  if (!agents.length && !error) return null;
  const names = new Map(agents.map((agent) => [agent.agentId, agent.name]));
  const needle = query.trim().toLocaleLowerCase();
  const visible = agents.filter(
    (agent) =>
      (filter === "all" ||
        (filter === "active"
          ? ACTIVE.has(agent.status)
          : ["failed", "interrupted"].includes(agent.status))) &&
      `${agent.name}\n${agent.description}\n${agent.model ?? ""}`
        .toLocaleLowerCase()
        .includes(needle),
  );
  return (
    <section className="agent-panel" aria-label="子任务">
      <button
        className="agent-panel-toggle"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <GitBranch size={15} />
        <strong>子任务</strong>
        <span>{agents.length} 总计</span>
        <AgentSummaryStats agents={agents} />
        <ChevronRight size={14} className={open ? "open" : ""} />
      </button>
      {error && (
        <div role="alert">
          {error}
          <span className="agent-refresh-hint">暂时无法刷新，已保留最近状态；将自动重试。</span>
          <button
            type="button"
            className="icon-button"
            aria-label="刷新子任务"
            title="刷新子任务"
            onClick={() => setAttempt((value) => value + 1)}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      )}
      {open && (
        <div className="agent-list">
          <div className="agent-filters">
            <div
              className="timeline-modes"
              role="group"
              aria-label="子任务状态"
            >
              {(
                [
                  ["all", "全部"],
                  ["active", "执行中"],
                  ["failed", "异常"],
                ] as const
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            <label className="timeline-search">
              <Search size={14} />
              <input
                type="search"
                aria-label="搜索子任务"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </div>
          {visible.length === 0 && (
            <p className="diff-empty" role="status">
              没有匹配的子任务
            </p>
          )}
          {visible.map((agent) => (
            <div key={agent.agentId}>
              <div className="agent-row">
                <button
                  type="button"
                  className="agent-open"
                  title={agent.description}
                  aria-expanded={selected === agent.agentId}
                  aria-controls={`${detailsId}-${agent.agentId}`}
                  onClick={() => select(agent.agentId)}
                >
                  <ChevronRight
                    size={14}
                    className={selected === agent.agentId ? "open" : ""}
                  />
                  {ACTIVE.has(agent.status) && (
                    <LoaderCircle size={13} className="activity-spinner" />
                  )}
                  <strong>{agent.name}</strong>
                  <span>{agent.description}</span>
                  <small>
                    {agent.parentId
                      ? `${names.get(agent.parentId) ?? agent.parentId} / `
                      : ""}
                    {agent.model ?? "默认模型"} ·{" "}
                    {LABELS[agent.status] ?? agent.status} ·{" "}
                    <time dateTime={agent.createdAt} title={conversationTimestamp(agent.createdAt)?.full}>
                      {conversationTimestamp(agent.createdAt)?.label}
                    </time>
                    {agent.elapsedMs !== undefined &&
                      formatDuration(agent.elapsedMs) && ` · ${agent.timingComplete === false ? "至少 " : ""}${formatDuration(agent.elapsedMs)}`}
                    {!!agent.heldMessagesCount &&
                      ` · ${agent.heldMessagesCount} 条待处理消息`}
                  </small>
                  {ACTIVE.has(agent.status) && agent.progress && (
                    <small className="agent-phase">
                      {turnProgressLabel(agent.progress)}
                      {agent.progress.modelStep != null && ` · 第 ${agent.progress.modelStep} 轮`}
                    </small>
                  )}
                  {agent.progress?.retry && (
                    <RetryNotice progress={agent.progress} />
                  )}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  title={`查看 ${agent.name} 模型调用`}
                  aria-label={`查看 ${agent.name} 模型调用`}
                  onClick={() => setDiagnostics(agent.agentId)}
                >
                  <Activity size={14} />
                </button>
                {ACTIVE.has(agent.status) && (
                  <button
                    className="icon-button"
                    type="button"
                    title={`停止 ${agent.name}`}
                    aria-label={`停止 ${agent.name}`}
                    disabled={stopping !== null || agent.status !== "running"}
                    onClick={() => void stopAgent(agent.agentId)}
                  >
                    <Square size={13} />
                  </button>
                )}
              </div>
              {selected === agent.agentId && (
                <div
                  id={`${detailsId}-${agent.agentId}`}
                  role="region"
                  aria-label={`${agent.name} 详情`}
                >
                  {pending && <div role="status">正在读取子任务</div>}
                  <button
                    type="button"
                    className="icon-button"
                    title={`刷新 ${agent.name} 结果`}
                    aria-label={`刷新 ${agent.name} 结果`}
                    disabled={pending}
                    onClick={() => void loadOutput(agent.agentId)}
                  >
                    <RefreshCw size={14} />
                  </button>
                  {resultError && <p role="alert">{resultError}</p>}
                  {result && (
                    <ToolPayload
                      label="子任务结果"
                      value={
                        result.result ??
                        result.error ??
                        LABELS[result.status] ??
                        result.status
                      }
                    />
                  )}
                  {!!result?.heldMessages?.length && (
                    <ToolPayload
                      label="待处理消息"
                      value={result.heldMessages}
                    />
                  )}
                  <details
                    open={activity}
                    onToggle={(event) => setActivity(event.currentTarget.open)}
                  >
                    <summary>执行记录</summary>
                    {activity && (
                      <AgentActivity
                        client={client}
                        sessionId={sessionId}
                        agentId={agent.agentId}
                        status={agent.status}
                      />
                    )}
                  </details>
                  <details
                    open={history}
                    onToggle={(event) => setHistory(event.currentTarget.open)}
                  >
                    <summary>对话历史</summary>
                    {history && (
                      <AgentHistory
                        client={client}
                        sessionId={sessionId}
                        agentId={agent.agentId}
                        status={agent.status}
                      />
                    )}
                  </details>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {diagnostics && (
        <ModelDiagnostics
          client={client}
          sessionId={sessionId}
          agentId={diagnostics}
          onClose={() => setDiagnostics(null)}
        />
      )}
    </section>
  );
}
