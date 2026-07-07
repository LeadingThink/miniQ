import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RpcClient, resolveConnection } from "./rpc";
import type {
  Approval,
  ApprovalMode,
  Artifact,
  DaemonEvent,
  HealthStatus,
  Message,
  PlanTask,
  Question,
  Session,
  ToolCall,
  Workspace,
} from "./types";
import { Sidebar } from "./components/Sidebar";
import { Timeline } from "./components/Timeline";
import { Composer, ComposerCard } from "./components/Composer";
import { SettingsPanel } from "./components/Settings";
import { SkillsPanel } from "./components/Skills";
import { DistillModal } from "./components/Distill";
import { McpPanel } from "./components/Mcp";
import { SchedulePanel } from "./components/Schedule";
import { SearchOverlay } from "./components/Search";
import { ProjectPicker } from "./components/ProjectPicker";

export interface PendingApproval {
  approval: Approval;
  toolName: string;
  input: unknown;
}

/** Native folder picker inside Tauri; plain prompt in browser dev mode. */
async function pickDirectory(): Promise<string | null> {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (w.__TAURI_INTERNALS__) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择工作区文件夹",
    });
    return typeof selected === "string" ? selected : null;
  }
  return window.prompt("工作区目录(绝对路径):");
}

export default function App() {
  const clientRef = useRef<RpcClient>();
  if (!clientRef.current) clientRef.current = new RpcClient();
  const client = clientRef.current;

  const [connected, setConnected] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [plan, setPlan] = useState<PlanTask[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [streamingText, setStreamingText] = useState<string>("");
  const [showSettings, setShowSettings] = useState(false);
  const [showDistill, setShowDistill] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  /** Full pages rendered in the main sheet (mutually exclusive with a session view). */
  const [page, setPage] = useState<"schedule" | "skills" | "mcp" | null>(null);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("auto");

  const currentSession = useMemo(
    () => sessions.find((s) => s.id === currentSessionId) ?? null,
    [sessions, currentSessionId],
  );
  const selectedWorkspace = useMemo(
    () =>
      workspaces.find((w) => w.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [workspaces, selectedWorkspaceId],
  );
  const currentWorkspace = useMemo(
    () => workspaces.find((w) => w.id === currentSession?.workspaceId) ?? null,
    [workspaces, currentSession],
  );

  const refreshSessions = useCallback(async () => {
    const res = await client.call<{ sessions: Session[] }>("session.list", {});
    setSessions(res.sessions);
  }, [client]);

  const refreshWorkspaces = useCallback(async () => {
    const res = await client.call<{ workspaces: Workspace[] }>("workspace.list");
    setWorkspaces(res.workspaces);
  }, [client]);

  // Connect on mount. The daemon may still be starting up (the shell spawns
  // it and waits for a health check), so retry with a short delay instead of
  // giving up on the first failure.
  useEffect(() => {
    let disposed = false;
    (async () => {
      const maxAttempts = 10;
      for (let attempt = 1; !disposed; attempt++) {
        try {
          const info = await resolveConnection();
          await client.connect(info);
          if (disposed) return;
          setConnected(true);
          setHealth(await client.call<HealthStatus>("daemon.health"));
          const settings = await client.call<{ approvalMode?: ApprovalMode }>(
            "settings.get",
          );
          if (settings.approvalMode) setApprovalMode(settings.approvalMode);
          await refreshWorkspaces();
          await refreshSessions();
          setError(null);
          return;
        } catch (e) {
          if (disposed) return;
          if (attempt >= maxAttempts) {
            setError(e instanceof Error ? e.message : String(e));
            return;
          }
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    })();
    const offStatus = client.onStatus(setConnected);
    return () => {
      disposed = true;
      offStatus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Daemon event handling.
  useEffect(() => {
    return client.onEvent((event: DaemonEvent) => {
      if ("sessionId" in event && event.sessionId !== currentSessionId) {
        if (event.type === "session_status_changed") void refreshSessions();
        return;
      }
      switch (event.type) {
        case "session_status_changed":
          setSessions((prev) =>
            prev.map((s) =>
              s.id === event.sessionId ? { ...s, status: event.status } : s,
            ),
          );
          break;
        case "message_created":
          setMessages((prev) =>
            prev.some((m) => m.id === event.message.id)
              ? prev
              : [...prev, event.message],
          );
          if (event.message.role === "assistant") setStreamingText("");
          break;
        case "assistant_delta":
          setStreamingText((prev) => prev + event.delta);
          break;
        case "tool_call_started":
          setToolCalls((prev) => [
            ...prev.filter((t) => t.id !== event.toolCallId),
            {
              id: event.toolCallId,
              sessionId: event.sessionId,
              toolName: event.toolName,
              input: event.input,
              status: "running",
              createdAt: new Date().toISOString(),
            },
          ]);
          break;
        case "tool_call_finished":
          setToolCalls((prev) => {
            const existing = prev.find((t) => t.id === event.toolCallId);
            if (!existing) return prev;
            return prev.map((t) =>
              t.id === event.toolCallId
                ? { ...t, status: event.status, output: event.output }
                : t,
            );
          });
          setApprovals((prev) =>
            prev.filter((a) => a.approval.toolCallId !== event.toolCallId),
          );
          break;
        case "approval_requested":
          setApprovals((prev) =>
            prev.some((a) => a.approval.id === event.approval.id)
              ? prev
              : [
                  ...prev,
                  {
                    approval: event.approval,
                    toolName: event.toolName,
                    input: event.input,
                  },
                ],
          );
          break;
        case "approval_resolved":
          setApprovals((prev) =>
            prev.filter((a) => a.approval.id !== event.approval.id),
          );
          break;
        case "plan_updated":
          setPlan(event.tasks);
          break;
        case "question_requested":
          setQuestions((prev) =>
            prev.some((q) => q.id === event.question.id)
              ? prev
              : [...prev, event.question],
          );
          break;
        case "question_resolved":
          setQuestions((prev) => prev.filter((q) => q.id !== event.questionId));
          break;
        case "artifact_created":
          setArtifacts((prev) =>
            prev.some((a) => a.id === event.artifact.id)
              ? prev
              : [...prev, event.artifact],
          );
          break;
        case "turn_completed":
        case "turn_failed":
          setStreamingText("");
          if (event.type === "turn_failed") setError(event.error);
          break;
      }
    });
  }, [client, currentSessionId, refreshSessions]);

  const openWorkspace = useCallback(async () => {
    const path = await pickDirectory();
    if (!path) return;
    try {
      const ws = await client.call<Workspace>("workspace.open", { path });
      await refreshWorkspaces();
      setSelectedWorkspaceId(ws.id);
      setCurrentSessionId(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, refreshWorkspaces]);

  const createBlankProject = useCallback(
    async (name: string) => {
      try {
        const ws = await client.call<Workspace>("workspace.create", { name });
        await refreshWorkspaces();
        setSelectedWorkspaceId(ws.id);
        setCurrentSessionId(null);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [client, refreshWorkspaces],
  );

  /** "新对话": back to the hero composer, keeping the selected project. */
  const newChat = useCallback(() => {
    setCurrentSessionId(null);
    setShowSettings(false);
    setShowSearch(false);
    setPage(null);
  }, []);

  const resetSessionView = () => {
    setMessages([]);
    setToolCalls([]);
    setApprovals([]);
    setQuestions([]);
    setPlan([]);
    setArtifacts([]);
    setStreamingText("");
  };

  const createSession = useCallback(
    async (workspaceId: string) => {
      const session = await client.call<Session>("session.create", { workspaceId });
      await refreshSessions();
      setSelectedWorkspaceId(workspaceId);
      setCurrentSessionId(session.id);
      setPage(null);
      resetSessionView();
      return session;
    },
    [client, refreshSessions],
  );

  const openSession = useCallback(
    async (sessionId: string) => {
      const res = await client.call<{
        session: Session;
        messages: Message[];
        toolCalls: ToolCall[];
        artifacts: Artifact[];
        plan: PlanTask[];
      }>("session.open", { sessionId });
      setCurrentSessionId(sessionId);
      setSelectedWorkspaceId(res.session.workspaceId);
      setPage(null);
      resetSessionView();
      setMessages(res.messages);
      setToolCalls(res.toolCalls);
      setPlan(res.plan ?? []);
      setArtifacts(res.artifacts ?? []);
    },
    [client],
  );

  const sendMessage = useCallback(
    async (content: string) => {
      if (!currentSessionId) return;
      setError(null);
      try {
        await client.call("session.sendMessage", {
          sessionId: currentSessionId,
          message: { role: "user", content },
        });
        // Pick up the auto-generated session title.
        void refreshSessions();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [client, currentSessionId, refreshSessions],
  );

  /** Hero flow: type a goal -> session is created and the goal sent. */
  const startTask = useCallback(
    async (content: string) => {
      if (!selectedWorkspace) {
        setError("请先选择一个项目(或新建一个)");
        return;
      }
      setError(null);
      try {
        const session = await createSession(selectedWorkspace.id);
        await client.call("session.sendMessage", {
          sessionId: session.id,
          message: { role: "user", content },
        });
        // Sync anything we missed while the event listener re-bound, and
        // pick up the auto-generated title.
        await openSession(session.id);
        void refreshSessions();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [client, selectedWorkspace, createSession, openSession, refreshSessions],
  );

  const changeApprovalMode = useCallback(
    async (mode: ApprovalMode) => {
      const previous = approvalMode;
      setApprovalMode(mode);
      try {
        await client.call("settings.update", { approvalMode: mode });
      } catch (e) {
        setApprovalMode(previous);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [client, approvalMode],
  );

  const cancelTurn = useCallback(async () => {
    if (!currentSessionId) return;
    await client.call("session.cancel", { sessionId: currentSessionId });
  }, [client, currentSessionId]);

  const resolveApproval = useCallback(
    async (approvalId: string, decision: string) => {
      try {
        await client.call("approval.resolve", { approvalId, decision });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [client],
  );

  const resolveQuestion = useCallback(
    async (questionId: string, answer: string) => {
      try {
        await client.call("question.resolve", { questionId, answer });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [client],
  );

  const rollbackCheckpoint = useCallback(
    async (checkpointId: string) => {
      try {
        const res = await client.call<{ restored: string }>("checkpoint.rollback", {
          checkpointId,
        });
        setError(null);
        window.alert(`已恢复: ${res.restored}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [client],
  );

  const busy =
    currentSession?.status === "running" ||
    currentSession?.status === "waiting_approval";

  return (
    <div className="app">
      <Sidebar
        workspaces={workspaces}
        sessions={sessions}
        currentSessionId={currentSessionId}
        selectedWorkspaceId={selectedWorkspace?.id ?? null}
        onNewChat={newChat}
        onShowSearch={() => setShowSearch(true)}
        onShowSchedule={() => setPage("schedule")}
        onSelectWorkspace={(id) => {
          setSelectedWorkspaceId(id);
          setCurrentSessionId(null);
          setPage(null);
          resetSessionView();
        }}
        onCreateSession={createSession}
        onSelectSession={openSession}
        onShowSkills={() => setPage("skills")}
        onShowMcp={() => setPage("mcp")}
        onShowSettings={() => setShowSettings(true)}
      />
      <div className="main">
        <div className="statusbar">
          <span className={`dot ${connected ? "ok" : "bad"}`} />
          <span>
            {connected ? `daemon v${health?.daemonVersion ?? "?"}` : "未连接"}
          </span>
          {currentSession && (
            <span className={`badge ${currentSession.status}`}>
              {currentSession.status}
            </span>
          )}
          <span style={{ flex: 1 }} />
          {currentSession &&
            !busy &&
            messages.some((m) => m.role === "assistant") && (
              <button className="ghost" onClick={() => setShowDistill(true)}>
                ✦ 保存为技能
              </button>
            )}
        </div>
        {error && (
          <div className="error-banner">
            <span style={{ flex: 1 }}>{error}</span>
            <span className="banner-close" onClick={() => setError(null)}>
              ✕
            </span>
          </div>
        )}
        {showSettings && (
          <SettingsPanel client={client} onClose={() => setShowSettings(false)} />
        )}
        {showSearch && (
          <SearchOverlay
            sessions={sessions}
            workspaces={workspaces}
            onSelectSession={(id) => void openSession(id)}
            onClose={() => setShowSearch(false)}
          />
        )}
        {showDistill && currentSessionId && (
          <DistillModal
            client={client}
            sessionId={currentSessionId}
            onClose={() => setShowDistill(false)}
          />
        )}
        {page === "schedule" ? (
          <SchedulePanel
            client={client}
            workspaces={workspaces}
            defaultWorkspaceId={selectedWorkspace?.id ?? null}
            onClose={() => setPage(null)}
            onOpenSession={(id) => void openSession(id)}
          />
        ) : page === "skills" ? (
          <SkillsPanel client={client} workspaceId={selectedWorkspace?.id ?? null} />
        ) : page === "mcp" ? (
          <McpPanel client={client} />
        ) : currentSessionId ? (
          <>
            <Timeline
              messages={messages}
              toolCalls={toolCalls}
              approvals={approvals}
              questions={questions}
              plan={plan}
              artifacts={artifacts}
              streamingText={streamingText}
              busy={!!busy}
              onResolveApproval={resolveApproval}
              onResolveQuestion={resolveQuestion}
              onRollback={rollbackCheckpoint}
            />
            <Composer
              busy={!!busy}
              chip={currentWorkspace?.name}
              approvalMode={approvalMode}
              onApprovalModeChange={changeApprovalMode}
              onSend={sendMessage}
              onCancel={cancelTurn}
            />
          </>
        ) : (
          <div className="hero">
            <h1>
              {selectedWorkspace
                ? `要在 ${selectedWorkspace.name} 中完成什么?`
                : "今天想完成什么?"}
            </h1>
            <div className="hero-composer">
              <ComposerCard
                busy={false}
                autoFocus
                placeholder={
                  selectedWorkspace
                    ? "描述你的目标,例如:整理这份资料并生成周报"
                    : "先选择一个项目,再描述你的目标"
                }
                chipSlot={
                  <ProjectPicker
                    workspaces={workspaces}
                    selectedId={selectedWorkspace?.id ?? null}
                    onSelect={(id) => {
                      setSelectedWorkspaceId(id);
                      setCurrentSessionId(null);
                    }}
                    onCreateBlank={(name) => void createBlankProject(name)}
                    onOpenFolder={() => void openWorkspace()}
                  />
                }
                approvalMode={approvalMode}
                onApprovalModeChange={changeApprovalMode}
                onSend={startTask}
              />
            </div>
            <div className="hero-cards">
              <div className="hero-card" onClick={() => setPage("skills")}>
                <div className="hero-card-title">✦ 技能</div>
                <div className="hero-card-sub">查看可复用的工作流,或从任务中学习新技能</div>
              </div>
              <div className="hero-card" onClick={() => setPage("mcp")}>
                <div className="hero-card-title">🔌 连接 MCP</div>
                <div className="hero-card-sub">接入外部工具与服务,扩展 agent 能力</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
