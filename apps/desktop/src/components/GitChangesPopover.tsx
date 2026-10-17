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

export function GitChangesPopover(props: {
  client: RpcClient;
  sessionId: string;
  refreshKey: string;
  onOpenAll: () => void;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<GitStatusSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    void props.client
      .call<GitStatusSummary>(
        "git.status",
        { sessionId: props.sessionId },
        { signal: abort.signal },
      )
      .then(setStatus)
      .catch(() => {
        if (!abort.signal.aborted) setStatus(null);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [props.client, props.sessionId, props.refreshKey, revision]);

  if (!loading && (!status || status.entries.length === 0)) return null;
  const additions = status?.stats?.additions ?? 0;
  const deletions = status?.stats?.deletions ?? 0;
  const branch = status?.branch?.split("...")[0] ?? "Git";

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
        {status && <span className="git-changes-count">{status.entries.length}</span>}
      </button>
      <Popover open={open} anchorRef={anchor} onClose={close} label="Git 变更" className="git-changes-popover">
        <header>
          <span><GitBranch size={15} /> <strong>{branch}</strong></span>
          <button type="button" className="icon-button" aria-label="刷新 Git 变更" title="刷新 Git 变更" onClick={() => setRevision((value) => value + 1)}>
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
          <span>{status?.entries.length ?? 0} 个文件</span>
          <button type="button" onClick={() => {
            close();
            props.onOpenAll();
          }}>查看全部</button>
        </footer>
      </Popover>
    </>
  );
}