import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import { ToolPayload } from "./ToolPayload";

type Props = {
  client: RpcClient;
  sessionId: string;
  agentId: string;
  status: string;
};
type Cursor = { revision: number; before: number };
type Entry = {
  index: number;
  role: string;
  textCharacters: number;
  toolCount: number;
  imageCount: number;
};
type Page = { revision: number; entries: Entry[]; nextCursor: Cursor | null };
const roles: Record<string, string> = {
  user: "用户",
  assistant: "助手",
  system: "系统",
  tool: "工具结果",
};

export function AgentHistory(props: Props) {
  return (
    <HistoryPage
      key={JSON.stringify([props.sessionId, props.agentId])}
      {...props}
    />
  );
}

function HistoryPage({ client, sessionId, agentId, status }: Props) {
  const [page, setPage] = useState<Page | null>(null);
  const [cursors, setCursors] = useState<Array<Cursor | null>>([null]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPage(null);
    void client
      .call<Page>(
        "agent.history",
        { sessionId, agentId, cursor, limit: 20 },
        { signal: controller.signal },
      )
      .then((value) => {
        if (!controller.signal.aborted) setPage(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, sessionId, agentId, cursor, status, revision]);
  useEffect(
    () =>
      client.onStatus((connected) => {
        if (connected) setRevision((value) => value + 1);
      }),
    [client],
  );

  return (
    <section aria-label="子任务对话历史" aria-busy={loading}>
      <nav className="history-pages" aria-label="子任务历史分页">
        <button
          type="button"
          className="icon-button"
          title="刷新子任务历史"
          aria-label="刷新子任务历史"
          disabled={loading}
          onClick={() => {
            setCursors([null]);
            setRevision((value) => value + 1);
          }}
        >
          <RefreshCw size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="较新的子任务消息"
          aria-label="较新的子任务消息"
          disabled={loading || cursors.length === 1}
          onClick={() => setCursors((value) => value.slice(0, -1))}
        >
          <ChevronLeft size={14} />
        </button>
        <span>第 {cursors.length} 页</span>
        <button
          type="button"
          className="icon-button"
          title="较早的子任务消息"
          aria-label="较早的子任务消息"
          disabled={loading || !page?.nextCursor}
          onClick={() => {
            if (page?.nextCursor)
              setCursors((value) => [...value, page.nextCursor]);
          }}
        >
          <ChevronRight size={14} />
        </button>
      </nav>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">正在读取子任务历史</p>}
      {page?.entries.length === 0 && <p>暂无子任务历史</p>}
      {page?.entries.map((entry) => (
        <HistoryEntry
          key={`${page.revision}:${entry.index}`}
          client={client}
          sessionId={sessionId}
          agentId={agentId}
          revision={page.revision}
          entry={entry}
        />
      ))}
    </section>
  );
}

function HistoryEntry({
  client,
  sessionId,
  agentId,
  revision,
  entry,
}: Omit<Props, "status"> & { revision: number; entry: Entry }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError(null);
    void client
      .call<{ message: unknown }>(
        "agent.message",
        { sessionId, agentId, revision, index: entry.index },
        { signal: controller.signal },
      )
      .then((value) => {
        if (!controller.signal.aborted) setMessage(value.message);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [client, sessionId, agentId, revision, entry.index, open, attempt]);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        {entry.index + 1}. {roles[entry.role] ?? entry.role} ·{" "}
        {entry.textCharacters.toLocaleString()} 字符
        {entry.toolCount > 0 && ` · ${entry.toolCount} 个调用`}
        {entry.imageCount > 0 && ` · ${entry.imageCount} 个图像`}
      </summary>
      {open && (
        <>
          {error && (
            <p role="alert">
              {error}
              <button
                type="button"
                className="icon-button"
                title="重试读取消息"
                aria-label="重试读取消息"
                onClick={() => setAttempt((value) => value + 1)}
              >
                <RefreshCw size={14} />
              </button>
            </p>
          )}
          {!message && !error && <p role="status">正在读取消息</p>}
          {message !== null && <ToolPayload label="完整消息" value={message} />}
        </>
      )}
    </details>
  );
}
