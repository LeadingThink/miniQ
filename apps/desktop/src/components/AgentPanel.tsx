import {
  ChevronRight,
  GitBranch,
  LoaderCircle,
  RefreshCw,
  Square,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { RpcClient } from "../rpc";
import { ToolPayload } from "./ToolPayload";
import type { TurnProgress } from "../types";
import { RetryNotice } from "./RetryNotice";

interface AgentSummary {
  agentId: string;
  parentId: string | null;
  name: string;
  description: string;
  status: string;
  model: string | null;
  createdAt: string;
  queuedMessages: number;
  error: string | null;
  result?: string | null;
  progress?: TurnProgress | null;
}

const ACTIVE = new Set(["running", "stopping", "finalizing"]);
const LABELS: Record<string, string> = {
  running: "执行中",
  stopping: "正在停止",
  finalizing: "正在收尾",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
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
  const actionEpoch = useRef(0);
  const detailsId = useId();

  useEffect(() => {
    let stale = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (stale || inFlight) return;
      if (document.visibilityState === "hidden") {
        timer = setTimeout(() => void refresh(), 2500);
        return;
      }
      inFlight = true;
      try {
        const response = await client.call<{ agents: AgentSummary[] }>(
          "agent.list",
          { sessionId }
        );
        if (stale) return;
        setAgents(response.agents);
        setError(null);
        if (busy || response.agents.some((agent) => ACTIVE.has(agent.status)))
          timer = setTimeout(() => void refresh(), 2500);
      } catch (cause) {
        if (!stale) setError(String(cause));
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const reconnect = client.onStatus((connected) => {
      if (connected && !stale) {
        clearTimeout(timer);
        void refresh();
      }
    });
    return () => {
      stale = true;
      clearTimeout(timer);
      reconnect();
    };
  }, [client, sessionId, busy, attempt]);

  useEffect(
    () => () => {
      actionEpoch.current++;
    },
    [sessionId]
  );

  const act = async (agentId: string, stop: boolean) => {
    const epoch = ++actionEpoch.current;
    if (!stop && selected === agentId) {
      setSelected(null);
      setResult(null);
      setPending(false);
      return;
    }
    setSelected(agentId);
    setPending(true);
    setResult(null);
    try {
      const value = await client.call<AgentSummary>(
        stop ? "agent.stop" : "agent.output",
        { sessionId, agentId }
      );
      if (epoch !== actionEpoch.current) return;
      setResult(value);
      if (stop) setAttempt((value) => value + 1);
    } catch (cause) {
      if (epoch === actionEpoch.current) setError(String(cause));
    } finally {
      if (epoch === actionEpoch.current) setPending(false);
    }
  };

  if (!agents.length && !error) return null;
  const names = new Map(agents.map((agent) => [agent.agentId, agent.name]));
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
        <span>
          {agents.filter((agent) => ACTIVE.has(agent.status)).length} 执行中 /{" "}
          {agents.length} 总计
        </span>
        <ChevronRight size={14} className={open ? "open" : ""} />
      </button>
      {error && (
        <div role="alert">
          {error}
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
          {agents.map((agent) => (
            <div key={agent.agentId}>
              <div className="agent-row">
                <button
                  type="button"
                  className="agent-open"
                  title={agent.description}
                  aria-expanded={selected === agent.agentId}
                  aria-controls={`${detailsId}-${agent.agentId}`}
                  onClick={() => void act(agent.agentId, false)}
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
                    {new Date(agent.createdAt).toLocaleTimeString()}
                  </small>
                  {agent.progress?.phase === "waiting_retry" && (
                    <RetryNotice progress={agent.progress} />
                  )}
                </button>
                {ACTIVE.has(agent.status) && (
                  <button
                    className="icon-button"
                    type="button"
                    title={`停止 ${agent.name}`}
                    aria-label={`停止 ${agent.name}`}
                    disabled={pending || agent.status !== "running"}
                    onClick={() => void act(agent.agentId, true)}
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
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
