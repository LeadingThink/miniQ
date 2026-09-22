import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SchedulePanel } from "../components/Schedule";
import { AgentPanel } from "../components/AgentPanel";
import { Timeline } from "../components/Timeline";
import type { AgentSummary } from "../components/AgentSummary";
import type { RpcClient } from "../rpc";
import type { ScheduledTask, Session, Workspace } from "../types";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/conversation.css";
import "../styles/interactions.css";
import "../styles/experience.css";
import "../styles/pages.css";
import "../styles/scheduling.css";

// Development fixture: no daemon connection, credentials or provider calls.
const now = new Date().toISOString();
const workspaces: Workspace[] = ["产品研发", "资料整理"].map((name, index) => ({
  id: `project-${index}`, name, path: `/sample/${index}`, additionalPaths: [], createdAt: now, updatedAt: now,
}));
const sessions: Session[] = workspaces.map((workspace, index) => ({
  id: `session-${index}`, workspaceId: workspace.id, workingDirectory: workspace.path,
  title: index === 0 ? "持续跟进移动端预览和会话稳定性" : "每周资料核查与待办整理",
  status: "idle", pinned: false, archived: false, createdAt: now, updatedAt: now,
}));
const initialTasks: ScheduledTask[] = [{
  id: "task-1", workspaceId: workspaces[0].id, name: "工作日巡检",
  prompt: "继续核查未完成事项，有变化时说明变化和下一步。",
  mode: "heartbeat", targetSessionId: sessions[0].id, memory: "已经完成文件预览；继续检查远程断连。",
  schedule: { type: "weekdays", weekdays: [1, 2, 3, 4, 5], time: "09:00" },
  enabled: false, nextRunAt: now, lastRunAt: now, lastSessionId: sessions[0].id, createdAt: now,
}];
const agents: AgentSummary[] = [
  { agentId: "research", parentId: null, name: "资料核查", description: "检查已有证据", status: "running", model: "示例模型", createdAt: now, queuedMessages: 0, error: null, progress: { phase: "receiving_model", modelStep: 3, startedAt: now } },
  { agentId: "retry", parentId: null, name: "测试执行", description: "等待连接恢复", status: "running", model: "示例模型", createdAt: now, queuedMessages: 0, error: null, progress: { phase: "waiting_retry", modelStep: 2, startedAt: now } },
  { agentId: "done", parentId: null, name: "文档整理", description: "整理检查结果", status: "completed", model: null, createdAt: now, queuedMessages: 0, error: null, result: "整理完成。" },
];
const noop = () => undefined;
const asyncNoop = async () => undefined;

function Fixture() {
  const [page, setPage] = useState("schedule");
  const [open, setOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const tasks = useRef(initialTasks);
  const client = useMemo(() => ({
    mode: "local",
    onStatus: () => noop,
    onEvent: () => noop,
    call: async (method: string, params: Record<string, unknown> = {}) => {
      if (method === "schedule.list") return { tasks: tasks.current };
      if (method === "session.list") return { sessions: sessions.filter((session) => session.workspaceId === params.workspaceId) };
      if (method === "schedule.create" || method === "schedule.update") {
        const previous = tasks.current.find((task) => task.id === params.id);
        const task = { ...initialTasks[0], enabled: true, lastRunAt: null, lastSessionId: null, ...previous, ...params, id: previous?.id ?? `new-${tasks.current.length}` } as ScheduledTask;
        tasks.current = [...tasks.current.filter((item) => item.id !== task.id), task];
        return task;
      }
      if (method === "schedule.toggle") {
        tasks.current = tasks.current.map((task) => task.id === params.id ? { ...task, enabled: !!params.enabled } : task);
        return tasks.current.find((task) => task.id === params.id);
      }
      if (method === "schedule.delete") { tasks.current = tasks.current.filter((task) => task.id !== params.id); return {}; }
      if (method === "schedule.runNow") return { sessionId: sessions[0].id };
      if (method === "agent.list") return { agents };
      if (method === "agent.output") return agents.find((agent) => agent.agentId === params.agentId);
      if (method === "voice.capabilities") return { transcription: false, speech: false };
      throw new Error(`验收样例不支持 ${method}`);
    },
  }) as unknown as RpcClient, []);
  return <main style={{ width: narrow ? 390 : "100%", maxWidth: "100%", height: "100dvh", margin: "auto", display: "flex", flexDirection: "column", overflow: "hidden" }}>
    <nav style={{ padding: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
      <button onClick={() => setPage("schedule")}>定时任务</button>
      <button onClick={() => setPage("timeline")}>子任务时间线</button>
      <button onClick={() => setNarrow(!narrow)}>{narrow ? "宽屏" : "390px 窄屏"}</button>
      <span style={{ color: "var(--text-dim)" }}>验收样例，不执行真实任务</span>
    </nav>
    {page === "schedule" ? <SchedulePanel client={client} workspaces={workspaces} defaultWorkspaceId={workspaces[0].id} onClose={noop} onOpenSession={() => setPage("timeline")} /> : <>
      <AgentPanel client={client} sessionId={sessions[0].id} busy agents={agents} open={open} onOpenChange={setOpen} />
      <Timeline sessionId={sessions[0].id} messages={[{ id: "message-1", sessionId: sessions[0].id, role: "user", content: "继续完成昨天的核查，资料研究和测试可以并行。", createdAt: now }]}
        agents={agents} onOpenAgentPanel={() => setOpen(true)} toolCalls={[]} approvals={[]} questions={[]} plan={[]} artifacts={[]} queue={[]}
        streamingText="正在并行核查资料和测试结果。" turnProgress={{ phase: "receiving_model", modelStep: 3, startedAt: now }} busy
        onResolveApproval={noop} onResolveQuestion={noop} onRollback={noop} onOpenFile={noop} onOpenUrl={noop}
        onSteerQueued={asyncNoop} onRemoveQueued={asyncNoop} onUpdateQueued={asyncNoop} onRewrite={async () => true} onError={noop} />
    </>}
  </main>;
}

if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Fixture />);
