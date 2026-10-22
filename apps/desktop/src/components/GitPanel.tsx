import { FileCode2, GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { RpcClient } from "../rpc";
import { UnifiedDiffView } from "./UnifiedDiffView";
import "./GitPanel.css";

interface GitEntry {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
}

interface GitStatus {
  root: string;
  branch: string | null;
  entries: GitEntry[];
}

/** Keep the filename visible when a long path is truncated. */
function fileLabel(path: string): { name: string; directory: string } {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (slash < 0) return { name: path, directory: "" };
  return { name: path.slice(slash + 1), directory: path.slice(0, slash + 1) };
}

export function GitPanel({ client, sessionId }: { client: RpcClient; sessionId: string }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [staged, setStaged] = useState(false);
  const [diff, setDiff] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    void client.call<GitStatus>("git.status", { sessionId }, { signal: abort.signal })
      .then((next) => {
        setStatus(next);
        setSelectedPath((current) =>
          current && next.entries.some((entry) => entry.path === current)
            ? current
            : (next.entries[0]?.path ?? null),
        );
      })
      .catch((reason) => {
        if (!abort.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [client, sessionId, revision]);

  const selected = status?.entries.find((entry) => entry.path === selectedPath);
  useEffect(() => {
    if (!selected) {
      setDiff("");
      return;
    }
    const canShowStaged = selected.indexStatus !== " " && selected.indexStatus !== "?";
    const canShowWorktree = selected.worktreeStatus !== " ";
    const nextStaged = staged ? canShowStaged : !canShowWorktree && canShowStaged;
    if (nextStaged !== staged) {
      setStaged(nextStaged);
      return;
    }
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    void client.call<{ diff: string }>("git.diff", {
      sessionId,
      path: selected.path,
      staged: nextStaged,
    }, { signal: abort.signal })
      .then((result) => setDiff(result.diff))
      .catch((reason) => {
        if (!abort.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [
    client,
    sessionId,
    selected?.path,
    selected?.indexStatus,
    selected?.worktreeStatus,
    staged,
    revision,
  ]);

  return (
    <section className="git-panel" aria-label="Git 工作区">
      <header className="git-panel-header">
        <div>
          <GitBranch size={16} />
          <strong>{status?.branch ?? "Git"}</strong>
          {status?.root && <small title={status.root}>{status.root}</small>}
        </div>
        <button type="button" className="icon-button" aria-label="刷新 Git 状态" title="刷新 Git 状态" onClick={() => setRevision((value) => value + 1)}>
          <RefreshCw size={16} />
        </button>
      </header>
      {error && !status && <div className="git-panel-message" role="alert">{error}</div>}
      {!error && loading && !status && <div className="git-panel-message" role="status">正在读取 Git 状态…</div>}
      {status && status.entries.length === 0 && <div className="git-panel-message">工作区没有变更。</div>}
      {status && status.entries.length > 0 && (
        <div className="git-panel-body">
          <nav className="git-file-list" aria-label="Git 变更文件">
            {status.entries.map((entry) => {
              const label = fileLabel(entry.path);
              return (
                <button type="button" key={entry.path} className={entry.path === selectedPath ? "selected" : ""} aria-current={entry.path === selectedPath ? "true" : undefined} onClick={() => setSelectedPath(entry.path)} title={entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path}>
                  <FileCode2 size={15} />
                  <span>
                    {label.directory && <small>{label.directory}</small>}
                    <b>{label.name}</b>
                  </span>
                  <code aria-label={`暂存区 ${entry.indexStatus}，工作区 ${entry.worktreeStatus}`}>{entry.indexStatus}{entry.worktreeStatus}</code>
                </button>
              );
            })}
          </nav>
          <div className="git-diff-pane">
            <div className="git-diff-toolbar" role="group" aria-label="差异范围">
              <button type="button" aria-pressed={!staged} disabled={!selected || selected.worktreeStatus === " "} onClick={() => setStaged(false)}>工作区</button>
              <button type="button" aria-pressed={staged} disabled={!selected || selected.indexStatus === " " || selected.indexStatus === "?"} onClick={() => setStaged(true)}>暂存区</button>
            </div>
            {error && <div className="git-panel-message" role="alert">{error}</div>}
            {!error && loading && <div className="git-panel-message" role="status">正在加载差异…</div>}
            {!error && !loading && (diff ? (
              <UnifiedDiffView
                key={`${selected?.path ?? ""}:${staged}:${revision}`}
                diff={diff}
                path={selected?.path ?? ""}
              />
            ) : (
              <div className="git-panel-message">没有文本差异。</div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
