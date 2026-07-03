import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RpcClient, resolveConnection } from "./rpc";
import type {
  Approval,
  DaemonEvent,
  HealthStatus,
  Message,
  Session,
  ToolCall,
  Workspace,
} from "./types";
import { Sidebar } from "./components/Sidebar";
import { Timeline } from "./components/Timeline";
import { Composer } from "./components/Composer";
import { SettingsPanel } from "./components/Settings";

export interface PendingApproval {
  approval: Approval;
  toolName: string;
  input: unknown;
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
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [streamingText, setStreamingText] = useState<string>("");
  const [showSettings, setShowSettings] = useState(false);

  const currentSession = useMemo(
    () => sessions.find((s) => s.id === currentSessionId) ?? null,
    [sessions, currentSessionId],
  );

  const refreshSessions = useCallback(async () => {
    const res = await client.call<{ sessions: Session[] }>("session.list", {});
    setSessions(res.sessions);
  }, [client]);

  const refreshWorkspaces = useCallback(async () => {
    const res = await client.call<{ workspaces: Workspace[] }>("workspace.list");
    setWorkspaces(res.workspaces);
  }, [client]);

  // Connect on mount.
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const info = await resolveConnection();
        await client.connect(info);
        if (disposed) return;
        setConnected(true);
        setHealth(await client.call<HealthStatus>("daemon.health"));
        await refreshWorkspaces();
        await refreshSessions();
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
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
        // Still refresh session list state transitions for other sessions.
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
          setMessages((prev) => [...prev, event.message]);
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
          setApprovals((prev) => [
            ...prev,
            { approval: event.approval, toolName: event.toolName, input: event.input },
          ]);
          break;
        case "approval_resolved":
          setApprovals((prev) =>
            prev.filter((a) => a.approval.id !== event.approval.id),
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
    const path = window.prompt("Workspace directory (absolute path):");
    if (!path) return;
    try {
      await client.call("workspace.open", { path });
      await refreshWorkspaces();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, refreshWorkspaces]);

  const createSession = useCallback(
    async (workspaceId: string) => {
      const session = await client.call<Session>("session.create", { workspaceId });
      await refreshSessions();
      setCurrentSessionId(session.id);
      setMessages([]);
      setToolCalls([]);
      setApprovals([]);
      setStreamingText("");
    },
    [client, refreshSessions],
  );

  const openSession = useCallback(
    async (sessionId: string) => {
      const res = await client.call<{
        session: Session;
        messages: Message[];
        toolCalls: ToolCall[];
      }>("session.open", { sessionId });
      setCurrentSessionId(sessionId);
      setMessages(res.messages);
      setToolCalls(res.toolCalls);
      setApprovals([]);
      setStreamingText("");
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
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [client, currentSessionId],
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

  const busy =
    currentSession?.status === "running" ||
    currentSession?.status === "waiting_approval";

  return (
    <div className="app">
      <Sidebar
        workspaces={workspaces}
        sessions={sessions}
        currentSessionId={currentSessionId}
        onOpenWorkspace={openWorkspace}
        onCreateSession={createSession}
        onSelectSession={openSession}
      />
      <div className="main">
        <div className="statusbar">
          <span className={`dot ${connected ? "ok" : "bad"}`} />
          <span>
            {connected
              ? `daemon v${health?.daemonVersion ?? "?"} · protocol ${health?.protocolVersion ?? "?"}`
              : "disconnected"}
          </span>
          {currentSession && (
            <>
              <span>·</span>
              <span>{currentSession.title}</span>
              <span className={`badge ${currentSession.status}`}>
                {currentSession.status}
              </span>
            </>
          )}
          <span style={{ flex: 1 }} />
          <button className="secondary" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
        {showSettings && (
          <SettingsPanel client={client} onClose={() => setShowSettings(false)} />
        )}
        {error && <div className="error-banner">{error}</div>}
        {currentSessionId ? (
          <>
            <Timeline
              messages={messages}
              toolCalls={toolCalls}
              approvals={approvals}
              streamingText={streamingText}
              onResolveApproval={resolveApproval}
            />
            <Composer busy={!!busy} onSend={sendMessage} onCancel={cancelTurn} />
          </>
        ) : (
          <div className="empty-state">
            <div>Open a workspace and create a session to start.</div>
            <button onClick={openWorkspace}>Open workspace</button>
          </div>
        )}
      </div>
    </div>
  );
}
