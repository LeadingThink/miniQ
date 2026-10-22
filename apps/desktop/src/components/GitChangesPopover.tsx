import { GitBranch, ListTree, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "../rpc";
import { Popover } from "./ui/Popover";
import "./GitChangesPopover.css";

interface GitStatusSummary {
  root: string;
  branch: string | null;
  entries: unknown[];
  stats?: { additions: number; deletions: number };
}

/** One probe per window: a running turn changes tool calls constantly and every probe
 *  runs git, so bursts coalesce into a single lookup instead of queueing behind each other. */
const REFRESH_INTERVAL_MS = 1500;

/** Last snapshot per connection and session. Returning to a conversation paints its own
 *  previous count immediately and never borrows the count of the conversation before it. */
const statusCache = new WeakMap<RpcClient, Map<string, GitStatusSummary>>();

function cachedSessions(client: RpcClient): Map<string, GitStatusSummary> {
  let sessions = statusCache.get(client);
  if (!sessions) {
    sessions = new Map();
    statusCache.set(client, sessions);
  }
  return sessions;
}

export function GitChangesPopover(props: {
  client: RpcClient;
  sessionId: string;
  refreshKey: string;
  onOpenAll: () => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<{ sessionId: string; summary: GitStatusSummary } | null>(null);
  const [revision, setRevision] = useState(0);
  const lastFetch = useRef(0);
  const close = useCallback(() => setOpen(false), []);
  const cached = cachedSessions(props.client).get(props.sessionId) ?? null;
  const status = snapshot?.sessionId === props.sessionId ? snapshot.summary : cached;

  useEffect(() => {
    const abort = new AbortController();
    const sessionId = props.sessionId;
    const run = () => {
      lastFetch.current = Date.now();
      void props.client
        .call<GitStatusSummary>("git.status", { sessionId }, { signal: abort.signal })
        .then((next) => {
          cachedSessions(props.client).set(sessionId, next);
          setSnapshot({ sessionId, summary: next });
        })
        .catch(() => {
          if (abort.signal.aborted) return;
          cachedSessions(props.client).delete(sessionId);
          setSnapshot({ sessionId, summary: { root: "", branch: null, entries: [] } });
        });
    };
    // Stale-while-revalidate: the cached count stays visible while this runs.
    const wait = Math.max(0, REFRESH_INTERVAL_MS - (Date.now() - lastFetch.current));
    const handle = window.setTimeout(run, wait);
    return () => {
      abort.abort();
      window.clearTimeout(handle);
    };
  }, [props.client, props.sessionId, props.refreshKey, revision]);

  if (!status || status.entries.length === 0) return null;
  const additions = status.stats?.additions ?? 0;
  const deletions = status.stats?.deletions ?? 0;
  const branch = status.branch?.split("...")[0] ?? "Git";

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`statusbar-icon-button git-changes-trigger${open ? " active" : ""}`}
        title="查看 Git 变更"
        aria-label="查看 Git 变更"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ListTree size={16} />
        <span className="git-changes-count">{status.entries.length}</span>
      </button>
      <Popover open={open} anchorRef={anchor} onClose={close} label="Git 变更" className="git-changes-popover">
        <header>
          <span><GitBranch size={15} /> <strong>{branch}</strong></span>
          <button
            type="button"
            className="icon-button"
            aria-label="刷新 Git 变更"
            title="刷新 Git 变更"
            onClick={() => {
              lastFetch.current = 0;
              setRevision((value) => value + 1);
            }}
          >
            <RefreshCw size={15} />
          </button>
        </header>
        <button
          type="button"
          className="git-changes-summary"
          data-autofocus
          onClick={() => {
            close();
            props.onOpenAll();
          }}
        >
          <span>变更</span>
          <span className="git-changes-stats">
            <span className="diff-add">+{additions}</span>
            <span className="diff-delete">-{deletions}</span>
          </span>
        </button>
        <footer>
          <span>{status.entries.length} 个文件</span>
          <button type="button" onClick={() => {
            close();
            props.onOpenAll();
          }}>查看全部</button>
        </footer>
      </Popover>
    </>
  );
}
