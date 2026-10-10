import { useEffect, useState } from "react";
import { RpcClient, type LocalConnectionInfo } from "../../rpc";
import type { Session, Workspace } from "../../types";
import { isTauriRuntime } from "../../runtime";
import { errorMessage } from "../../errorMessage";

/** Dedicated local socket: no ConnectedApp, host catalog, notification or background hooks. */
export function useCompanionConnection(injected?: RpcClient) {
  const [client] = useState(() => injected ?? new RpcClient());
  const [connected, setConnected] = useState(Boolean(injected?.connected));
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [questions, setQuestions] = useState<Record<string, boolean>>({});
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let syncing = false;
    const pendingQuestions = new Map<string, Set<string>>();
    const refresh = async () => {
      if (syncing || disposed) return;
      syncing = true;
      try {
        if (client.mode !== "local") throw new Error("桌面伙伴仅允许连接本机服务");
        // Deliberately no resolveConnection(): that function can choose remote credentials.
        if (!client.connected) {
          if (!isTauriRuntime()) throw new Error("预览不会连接正式服务；请在桌面应用启用伙伴");
          const { invoke } = await import("@tauri-apps/api/core");
          const native = await invoke<Omit<LocalConnectionInfo, "kind">>("daemon_connection");
          if (disposed) return;
          if (!Number.isInteger(native.port) || native.port < 1 || native.port > 65535 || !native.token) throw new Error("无效的本机服务信息");
          await client.connect({ kind: "local", port: native.port, token: native.token });
        }
        if (disposed) return;
        const [projects, tasks] = await Promise.all([
          client.call<{ workspaces: Workspace[] }>("workspace.list"),
          client.call<{ sessions: Session[] }>("session.list", {}),
        ]);
        if (!disposed) {
          setWorkspaces(projects.workspaces);
          setSessions((current) => tasks.sessions.filter((s) => !s.external).map((s) => ({ ...s, turnCount: s.turnCount ?? current.find((old) => old.id === s.id)?.turnCount })));
          setConnected(true); setError(null);
        }
      } catch (cause) {
        if (!disposed) { setError(errorMessage(cause)); setConnected(client.connected); }
      } finally {
        syncing = false;
        if (!disposed) timer = setTimeout(() => void refresh(), 5000);
      }
    };
    const offStatus = client.onStatus((value) => { if (!disposed) setConnected(value); });
    const offEvent = client.onEvent((event) => {
      if (disposed) return;
      if (event.type === "turn_failed") {
        setFailures((current) => ({ ...current, [event.sessionId]: event.error }));
        setSessions((current) => current.map((s) => s.id === event.sessionId ? { ...s, status: "failed" } : s));
      } else if (event.type === "turn_completed") {
        setSessions((current) => current.map((s) => s.id === event.sessionId ? { ...s, status: "idle", turnCount: Math.max(1, s.turnCount ?? 0) } : s));
        setFailures((current) => { const next = { ...current }; delete next[event.sessionId]; return next; });
      } else if (event.type === "session_status_changed") {
        if (event.status === "running") setFailures((current) => { const next = { ...current }; delete next[event.sessionId]; return next; });
        setSessions((current) => current.map((s) => s.id !== event.sessionId ? s : {
          ...s, status: event.status,
          turnCount: event.status === "idle" && s.status === "running" ? Math.max(1, s.turnCount ?? 0) : s.turnCount,
        }));
      } else if (event.type === "question_requested" || event.type === "question_resolved") {
        const pending = pendingQuestions.get(event.sessionId) ?? new Set<string>();
        if (event.type === "question_requested") pending.add(event.question.id);
        else pending.delete(event.questionId);
        pendingQuestions.set(event.sessionId, pending);
        setQuestions((current) => ({ ...current, [event.sessionId]: pending.size > 0 }));
      } else if (event.type === "model_settings_changed") {
        setModels((current) => ({ ...current, [event.sessionId]: event.settings.model ?? "继承此会话默认设置" }));
      }
    });
    void refresh();
    return () => {
      disposed = true; clearTimeout(timer); offStatus(); offEvent();
      if (!injected) client.disconnect();
    };
  }, [client, injected, retry]);
  return { client, connected, workspaces, sessions, questions, models, failures, error, setSessions, reconnect: () => setRetry((n) => n + 1) };
}
