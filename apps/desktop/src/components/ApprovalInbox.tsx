import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import type { Approval, HistoryCursor, ToolCall } from "../types";
import { ApprovalCard } from "./TimelineInteractions";
import "./ModelDiagnostics.css";

type Props = { client: RpcClient; onOpenSession: (sessionId: string) => void };
type Entry = {
  approval: Approval;
  toolName: string;
  sessionTitle: string;
  agentId: string | null;
};
type Page = { entries: Entry[]; nextCursor: HistoryCursor | null };

export function ApprovalInboxButton(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="statusbar-icon-button"
        title="待审批总览"
        aria-label="待审批总览"
        onClick={() => setOpen(true)}
      >
        <ShieldCheck size={16} />
      </button>
      {open && <ApprovalInbox {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ApprovalInbox({
  client,
  onOpenSession,
  onClose,
}: Props & { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [cursors, setCursors] = useState<Array<HistoryCursor | null>>([null]);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cursor = cursors[cursors.length - 1];
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void client
      .call<Page>(
        "approval.inbox",
        { before: cursor },
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
  }, [client, cursor, revision]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((value) => value + 1), 100);
    };
    const events = client.onEvent((event) => {
      if (
        [
          "approval_requested",
          "approval_resolved",
          "session_status_changed",
          "session_deleted",
        ].includes(event.type)
      )
        refresh();
    });
    const status = client.onStatus((connected) => {
      if (connected) refresh();
    });
    return () => {
      clearTimeout(timer);
      events();
      status();
    };
  }, [client]);
  return (
    <dialog
      ref={dialog}
      className="model-diagnostics"
      aria-label="待审批总览"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <header>
        <h2>待审批总览</h2>
        <button
          type="button"
          className="icon-button"
          title="刷新待审批"
          aria-label="刷新待审批"
          disabled={loading}
          onClick={() => {
            setCursors([null]);
            setRevision((value) => value + 1);
          }}
        >
          <RefreshCw size={17} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="关闭待审批"
          aria-label="关闭待审批"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="model-diagnostics-body" aria-busy={loading}>
        {error && <p role="alert">{error}</p>}
        {loading && !page && <p role="status">正在读取待审批</p>}
        {page?.entries.length === 0 && <p>没有待审批的操作</p>}
        {page?.entries.map((entry) => (
          <PendingEntry
            key={entry.approval.id}
            client={client}
            entry={entry}
            onChanged={() => setRevision((value) => value + 1)}
            onOpenSession={() => {
              onOpenSession(entry.approval.sessionId);
              onClose();
            }}
          />
        ))}
      </div>
      <footer>
        <button
          type="button"
          className="icon-button"
          title="较新的审批"
          aria-label="较新的审批"
          disabled={loading || cursors.length === 1}
          onClick={() => {
            setPage(null);
            setCursors((value) => value.slice(0, -1));
          }}
        >
          <ChevronLeft size={18} />
        </button>
        <span>第 {cursors.length} 页</span>
        <button
          type="button"
          className="icon-button"
          title="较早的审批"
          aria-label="较早的审批"
          disabled={loading || !page?.nextCursor}
          onClick={() => {
            if (page?.nextCursor) {
              setCursors((value) => [...value, page.nextCursor]);
              setPage(null);
            }
          }}
        >
          <ChevronRight size={18} />
        </button>
      </footer>
    </dialog>
  );
}

function PendingEntry({
  client,
  entry,
  onChanged,
  onOpenSession,
}: {
  client: RpcClient;
  entry: Entry;
  onChanged: () => void;
  onOpenSession: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<ToolCall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const resolving = useRef(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError(null);
    void client
      .call<ToolCall>(
        "tool.detail",
        {
          sessionId: entry.approval.sessionId,
          toolCallId: entry.approval.toolCallId,
        },
        { signal: controller.signal },
      )
      .then((value) => {
        if (!controller.signal.aborted) setTool(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [client, open, entry.approval.sessionId, entry.approval.toolCallId]);
  const resolve = async (approvalId: string, decision: string) => {
    if (resolving.current) return;
    resolving.current = true;
    setPending(true);
    try {
      await client.call("approval.resolve", { approvalId, decision });
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause));
      onChanged();
    } finally {
      resolving.current = false;
      setPending(false);
    }
  };
  return (
    <article className="model-call">
      <button
        type="button"
        className="ghost"
        onClick={onOpenSession}
        title="打开所属会话"
      >
        {entry.sessionTitle}
      </button>
      <div className="model-call-meta">
        <span>{entry.agentId ? `子任务 ${entry.agentId}` : "主任务"}</span>
        <time dateTime={entry.approval.createdAt}>
          {new Date(entry.approval.createdAt).toLocaleString()}
        </time>
      </div>
      <details
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary>
          {entry.toolName} · {entry.approval.reason}
        </summary>
        {open && (
          <>
            {error && <p role="alert">{error}</p>}
            {!tool && !error && <p role="status">正在读取操作参数</p>}
            {tool && (
              <ApprovalCard
                item={{
                  approval: entry.approval,
                  toolName: entry.toolName,
                  input: tool.input,
                }}
                pending={pending}
                onResolve={(id, decision) => void resolve(id, decision)}
              />
            )}
          </>
        )}
      </details>
    </article>
  );
}
