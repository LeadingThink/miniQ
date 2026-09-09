import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import type { HistoryCursor, HistoryPage } from "../types";
import { ToolStep } from "./ExecutionActivity";

type Props = {
  client: RpcClient;
  sessionId: string;
  agentId: string;
  status: string;
};

export function AgentActivity(props: Props) {
  return (
    <ActivityPage
      key={JSON.stringify([props.sessionId, props.agentId])}
      {...props}
    />
  );
}

function ActivityPage({ client, sessionId, agentId, status }: Props) {
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [cursors, setCursors] = useState<Array<HistoryCursor | null>>([null]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void client
      .call<HistoryPage>(
        "session.history",
        {
          sessionId,
          agentId,
          before: cursor,
          filter: "activity",
          includeInternal: true,
          limit: 20,
        },
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
    <section aria-label="子任务执行记录" aria-busy={loading}>
      <nav className="history-pages" aria-label="子任务执行分页">
        <button
          type="button"
          className="icon-button"
          title="刷新子任务执行记录"
          aria-label="刷新子任务执行记录"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="较新的子任务步骤"
          aria-label="较新的子任务步骤"
          disabled={loading || cursors.length === 1}
          onClick={() => setCursors((value) => value.slice(0, -1))}
        >
          <ChevronLeft size={14} />
        </button>
        <span>第 {cursors.length} 页</span>
        <button
          type="button"
          className="icon-button"
          title="较早的子任务步骤"
          aria-label="较早的子任务步骤"
          disabled={loading || !page?.nextCursor}
          onClick={() => {
            if (page?.nextCursor) {
              setPage(null);
              setCursors((value) => [...value, page.nextCursor]);
            }
          }}
        >
          <ChevronRight size={14} />
        </button>
      </nav>
      {error && <p role="alert">{error}</p>}
      {loading && !page && <p role="status">正在读取执行记录</p>}
      {page?.toolCalls.length === 0 && <p>暂无执行记录</p>}
      {page?.toolCalls.map((call) => (
        <ToolStep key={call.id} call={call} client={client} />
      ))}
    </section>
  );
}
