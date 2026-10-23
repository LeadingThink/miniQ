import { Check, ChevronDown, GitBranch, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "../rpc";
import { UnifiedDiffView } from "./UnifiedDiffView";
import "./GitPanel.css";

interface GitEntry {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  additions: number;
  deletions: number;
}

interface GitStatus {
  root: string;
  branch: string | null;
  base?: string;
  entries: GitEntry[];
  stats: { additions: number; deletions: number };
}

interface BranchRef {
  name: string;
  remote: boolean;
  current: boolean;
}

type Scope = "worktree" | "base";

const SCOPE_LABELS: Record<Scope, string> = { worktree: "未提交", base: "分支" };

/** Keep the filename visible when a long path is truncated. */
function fileLabel(path: string): { name: string; directory: string } {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (slash < 0) return { name: path, directory: "" };
  return { name: path.slice(slash + 1), directory: path.slice(0, slash + 1) };
}

/** `main...origin/main` → { head: "main", upstream: "origin/main" } */
function splitBranch(branch: string | null | undefined): { head: string; upstream: string | null } {
  if (!branch) return { head: "未命名分支", upstream: null };
  const match = branch.match(/^(.+?)\.\.\.(.+)$/);
  if (match) return { head: match[1], upstream: match[2].replace(/^refs\/heads\//, "") };
  return { head: branch, upstream: null };
}

function statusLetter(entry: GitEntry): { letter: string; tone: string } {
  const code = entry.indexStatus !== " " ? entry.indexStatus : entry.worktreeStatus;
  if (code === "?" || code === "A") return { letter: "A", tone: "new" };
  if (code === "D") return { letter: "D", tone: "deleted" };
  if (code === "R") return { letter: "R", tone: "moved" };
  return { letter: "M", tone: "modified" };
}

export function GitPanel({ client, sessionId }: { client: RpcClient; sessionId: string }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [scope, setScope] = useState<Scope>("worktree");
  const [base, setBase] = useState<string | null>(null);
  const [branches, setBranches] = useState<BranchRef[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [diffs, setDiffs] = useState<Record<string, string>>({});
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const toolbarRef = useRef<HTMLDivElement>(null);

  const activeBase = scope === "base" ? base : null;

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    void client
      .call<GitStatus>("git.status", { sessionId, ...(activeBase ? { base: activeBase } : {}) }, { signal: abort.signal })
      .then((next) => {
        setStatus(next);
        setExpanded((current) => {
          const kept = current.filter((path) => next.entries.some((entry) => entry.path === path));
          if (kept.length === 0 && next.entries[0]) return [next.entries[0].path];
          return kept;
        });
      })
      .catch((reason) => {
        if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [client, sessionId, activeBase, revision]);

  useEffect(() => {
    const abort = new AbortController();
    void client
      .call<{ branches: BranchRef[] }>("git.branches", { sessionId }, { signal: abort.signal })
      .then((result) => setBranches(Array.isArray(result.branches) ? result.branches : []))
      .catch(() => undefined);
    return () => abort.abort();
  }, [client, sessionId, revision]);

  useEffect(() => {
    if (!scopeOpen && !branchOpen) return;
    const close = (event: MouseEvent) => {
      if (!toolbarRef.current?.contains(event.target as Node)) {
        setScopeOpen(false);
        setBranchOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [scopeOpen, branchOpen]);

  const loadDiff = useCallback(
    async (entry: GitEntry) => {
      const key = `${activeBase ?? ""}:${entry.path}`;
      if (diffs[key] !== undefined || loadingPath === key) return;
      setLoadingPath(key);
      try {
        const request = (staged: boolean) =>
          client.call<{ diff: string }>("git.diff", {
            sessionId,
            path: entry.path,
            staged,
            ...(activeBase ? { base: activeBase } : {}),
          });
        let result = await request(false);
        if (!result.diff && !activeBase && entry.indexStatus !== " " && entry.indexStatus !== "?") {
          result = await request(true);
        }
        setDiffs((current) => ({ ...current, [key]: result.diff }));
      } catch (reason) {
        setDiffs((current) => ({ ...current, [key]: "" }));
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setLoadingPath(null);
      }
    },
    [activeBase, client, diffs, loadingPath, sessionId],
  );

  const toggle = (entry: GitEntry) => {
    const open = expanded.includes(entry.path);
    setExpanded((current) => open ? current.filter((path) => path !== entry.path) : [...current, entry.path]);
    if (!open) void loadDiff(entry);
  };

  // 首个文件默认展开，补一次差异请求（只在还没缓存时触发）。
  useEffect(() => {
    const first = status?.entries[0];
    if (!first || !expanded.includes(first.path)) return;
    if (diffs[`${activeBase ?? ""}:${first.path}`] !== undefined) return;
    void loadDiff(first);
  }, [status, expanded, diffs, activeBase, loadDiff]);

  const current = splitBranch(status?.branch);
  const visible = branches.filter((branch) => branch.name.toLowerCase().includes(branchQuery.trim().toLowerCase()));
  const branchGroups = [
    { title: "本地分支", items: visible.filter((branch) => !branch.remote) },
    { title: "远程分支", items: visible.filter((branch) => branch.remote) },
  ];

  const pickBase = (name: string) => {
    setBase(name);
    setScope("base");
    setBranchOpen(false);
    setBranchQuery("");
    setExpanded([]);
    setDiffs({});
  };

  return (
    <section className="git-panel" aria-label="Git 工作区">
      <div className="git-toolbar" ref={toolbarRef}>
        <div className="git-scope">
          <button
            type="button"
            className="git-chip"
            aria-haspopup="menu"
            aria-expanded={scopeOpen}
            onClick={() => { setScopeOpen((open) => !open); setBranchOpen(false); }}
          >
            {scope === "base" ? <GitBranch size={13} aria-hidden="true" /> : <span className="git-chip-dot" aria-hidden="true" />}
            {SCOPE_LABELS[scope]}
            <ChevronDown size={13} aria-hidden="true" />
          </button>
          {scopeOpen && (
            <div className="git-menu" role="menu" aria-label="查看范围">
              <button type="button" role="menuitemradio" aria-checked={scope === "worktree"} onClick={() => { setScope("worktree"); setScopeOpen(false); setExpanded([]); setDiffs({}); }}>
                <span>未提交</span>
                {scope === "worktree" && <Check size={13} aria-hidden="true" />}
              </button>
              <button type="button" role="menuitemradio" aria-checked={scope === "base"} disabled={!base} onClick={() => { if (!base) return; setScope("base"); setScopeOpen(false); setExpanded([]); setDiffs({}); }}>
                <span>与分支比较</span>
                {scope === "base" && <Check size={13} aria-hidden="true" />}
              </button>
            </div>
          )}
        </div>
        {status && (
          <span className="git-total">
            <b>+{status.stats.additions}</b>
            <i>−{status.stats.deletions}</i>
          </span>
        )}
        <div className="git-branch-picker">
          <button
            type="button"
            className="git-chip git-branch-chip"
            aria-haspopup="menu"
            aria-expanded={branchOpen}
            title={status?.root}
            onClick={() => {
              setBranchOpen((open) => !open);
              setScopeOpen(false);
            }}
          >
            <span className="git-branch-name">{current.head}</span>
            <span className="git-branch-arrow" aria-hidden="true">→</span>
            <span className="git-branch-upstream">{activeBase ?? current.upstream ?? "无上游"}</span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
          {branchOpen && (
            <div className="git-menu git-branch-menu" role="menu" aria-label="选择分支">
              <label className="git-branch-search">
                <Search size={13} aria-hidden="true" />
                <input
                  autoFocus
                  value={branchQuery}
                  aria-label="搜索分支"
                  placeholder="搜索分支"
                  onChange={(event) => setBranchQuery(event.target.value)}
                />
              </label>
              {branchGroups.map((group) =>
                group.items.length ? (
                  <div key={group.title} className="git-branch-group">
                    <span className="git-branch-group-title">{group.title}</span>
                    {group.items.map((branch) => (
                      <button key={branch.name} type="button" role="menuitemradio" aria-checked={branch.name === activeBase} onClick={() => pickBase(branch.name)}>
                        <span>{branch.name}</span>
                        {branch.name === activeBase && <Check size={13} aria-hidden="true" />}
                      </button>
                    ))}
                  </div>
                ) : null,
              )}
              {visible.length === 0 && <span className="git-menu-empty">没有匹配的分支</span>}
            </div>
          )}
        </div>
        <button
          type="button"
          className="icon-button git-refresh"
          aria-label="刷新 Git 状态"
          title="刷新 Git 状态"
          onClick={() => { setRevision((value) => value + 1); setDiffs({}); }}
        >
          <RefreshCw size={15} />
        </button>
      </div>

      {error && <div className="git-panel-message" role="alert">{error}</div>}
      {!error && loading && !status && <div className="git-panel-message" role="status">正在读取 Git 状态…</div>}
      {status && status.entries.length === 0 && (
        <div className="git-panel-message">{scope === "base" ? `与 ${base} 没有差异。` : "工作区没有变更。"}</div>
      )}

      {status && status.entries.length > 0 && (
        <div className="git-file-stack">
          {status.entries.map((entry) => {
            const label = fileLabel(entry.path);
            const open = expanded.includes(entry.path);
            const key = `${activeBase ?? ""}:${entry.path}`;
            const flat = diffs[key];
            const { letter, tone } = statusLetter(entry);
            return (
              <article className={`git-file ${open ? "open" : ""}`} key={entry.path}>
                <button
                  type="button"
                  className="git-file-head"
                  aria-expanded={open}
                  title={entry.originalPath ? `${entry.originalPath} → ${entry.path}` : entry.path}
                  onClick={() => toggle(entry)}
                >
                  <span className={`git-file-badge ${tone}`} aria-hidden="true">{letter}</span>
                  <span className="git-file-path">
                    {label.directory && <small>{label.directory}</small>}
                    <b>{label.name}</b>
                  </span>
                  <span className="git-file-count">
                    <b>+{entry.additions}</b>
                    <i>−{entry.deletions}</i>
                  </span>
                  <ChevronDown size={14} className={`git-file-chevron ${open ? "open" : ""}`} aria-hidden="true" />
                </button>
                {open && (
                  <div className="git-file-body">
                    {flat === undefined ? (
                      <div className="git-panel-message" role="status">正在加载差异…</div>
                    ) : flat ? (
                      <UnifiedDiffView key={`${entry.path}:${activeBase ?? ""}:${revision}`} diff={flat} path={entry.path} />
                    ) : (
                      <div className="git-panel-message">没有文本差异。</div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
