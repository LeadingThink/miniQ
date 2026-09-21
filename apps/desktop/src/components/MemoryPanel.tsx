import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import "./MemoryPanel.css";

export type MemoryTarget = { scope: "workspace"; workspaceId: string } | { scope: "global" };
export interface MemoryRecord {
  id: string;
  workspaceId: string | null;
  scope: "workspace" | "global";
  content: string;
  createdAt: string;
  updatedAt: string;
}
export interface MemoryPage {
  memories: MemoryRecord[];
  nextCursor: { updatedAt: string; id: string } | null;
}
type Props = { client: RpcClient; workspaceId: string | null };

export function MemoryPanel(props: Props) {
  return <MemoryScopes key={props.workspaceId ?? "global"} {...props} />;
}

function MemoryScopes({ client, workspaceId }: Props) {
  const [scope, setScope] = useState<"workspace" | "global">(workspaceId ? "workspace" : "global");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const target: MemoryTarget = scope === "workspace" && workspaceId
    ? { scope, workspaceId } : { scope: "global" };
  return (
    <section className="memory-panel" aria-label="长期记忆管理">
      <p className="memory-description">查看 AI 已保存的偏好和项目事实。项目记忆仅供该项目使用，全局记忆可供所有项目使用。</p>
      <div className="memory-tabs" role="group" aria-label="记忆范围">
        <button type="button" disabled={!workspaceId} aria-pressed={scope === "workspace"} onClick={() => setScope("workspace")}>当前项目</button>
        <button type="button" aria-pressed={scope === "global"} onClick={() => setScope("global")}>全局</button>
      </div>
      {!workspaceId && <p className="memory-description">打开项目后，可管理该项目的记忆。</p>}
      <div className="memory-search" role="search">
        <input type="search" aria-label="搜索记忆" placeholder="搜索记忆内容" value={draft}
          onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              setQuery(draft);
            }
          }} />
        <button type="button" className="ghost" onClick={() => setQuery(draft)}>搜索</button>
        {(draft || query) && <button type="button" className="ghost" onClick={() => { setDraft(""); setQuery(""); }}>清除搜索</button>}
      </div>
      <MemoryList key={JSON.stringify([target, query])} client={client} target={target} query={query} />
    </section>
  );
}

function MemoryList({ client, target, query }: { client: RpcClient; target: MemoryTarget; query: string }) {
  const [page, setPage] = useState<MemoryPage | null>(null);
  const [cursors, setCursors] = useState<Array<MemoryPage["nextCursor"]>>([null]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshId, setRefreshId] = useState(0);
  const cursor = cursors[cursors.length - 1];
  const refresh = useCallback(() => setRefreshId((value) => value + 1), []);
  // The list is remounted for every scope or search change, aborting all stale work.
  useEffect(() => {
    const pending = new AbortController();
    setPage(null);
    setError(null);
    setLoading(true);
    void client.call<MemoryPage>("memory.list", { target, query, before: cursor, limit: 20 }, { signal: pending.signal })
      .then((result) => { if (!pending.signal.aborted) setPage(result); })
      .catch((cause) => { if (!pending.signal.aborted) setError(errorMessage(cause)); })
      .finally(() => { if (!pending.signal.aborted) setLoading(false); });
    return () => pending.abort();
  // target and query are immutable for this keyed component.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, cursor, refreshId]);
  useEffect(() => client.onStatus((connected) => { if (connected) refresh(); }), [client, refresh]);
  return (
    <div className="memory-list" aria-busy={loading}>
      <div className="memory-list-heading">
        <span>{target.scope === "global" ? "全局记忆" : "当前项目记忆"}{query && ` · 搜索：${query}`}</span>
        <button type="button" className="ghost" disabled={loading} onClick={refresh}>刷新记忆</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">正在读取记忆…</p>}
      {page?.memories.length === 0 && <p className="memory-empty">{query ? "没有匹配的记忆" : "这个范围还没有保存记忆"}</p>}
      {page?.memories.map((item) => <MemoryCard key={item.id} item={item} client={client} target={target} onDeleted={refresh} />)}
      <nav className="memory-pagination" aria-label="记忆分页">
        <button type="button" className="ghost" disabled={loading || cursors.length === 1} onClick={() => setCursors((current) => current.slice(0, -1))}>上一页</button>
        <span>第 {cursors.length} 页</span>
        <button type="button" className="ghost" disabled={loading || !page?.nextCursor} onClick={() => {
          if (page?.nextCursor) setCursors((current) => [...current, page.nextCursor]);
        }}>下一页</button>
      </nav>
    </div>
  );
}

function MemoryCard({ item, client, target, onDeleted }: {
  item: MemoryRecord; client: RpcClient; target: MemoryTarget; onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => () => request.current?.abort(), [client]);
  useEffect(() => { if (confirming) cancel.current?.focus(); }, [confirming]);
  const remove = async () => {
    if (request.current) return;
    const pending = new AbortController();
    request.current = pending;
    setDeleting(true);
    setError(null);
    try {
      await client.call("memory.delete", { target, id: item.id, expectedUpdatedAt: item.updatedAt, expectedContent: item.content }, { signal: pending.signal });
      if (!pending.signal.aborted) onDeleted();
    } catch (cause) {
      if (!pending.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!pending.signal.aborted) { setDeleting(false); request.current = null; }
    }
  };
  const date = new Date(item.updatedAt);
  const updated = Number.isNaN(date.getTime()) ? item.updatedAt : date.toLocaleString();
  return (
    <article className="memory-card">
      <p className="memory-excerpt">{item.content}</p>
      <details><summary>查看全文 <time dateTime={item.updatedAt}>· 更新于 {updated}</time></summary><pre>{item.content}</pre></details>
      {confirming ? (
        <div className="memory-confirm" role="alertdialog" aria-label="删除记忆确认" onKeyDown={(event) => {
          if (event.key === "Escape" && !deleting) { event.stopPropagation(); setConfirming(false); }
        }}>
          <p>确认删除这条{target.scope === "global" ? "全局" : "项目"}记忆？删除后，未来任务不再读取这条记忆，已有对话不会删除。</p>
          <pre>{item.content}</pre>
          {error && <p role="alert">{error}</p>}
          <div><button ref={cancel} type="button" className="ghost" disabled={deleting} onClick={() => setConfirming(false)}>取消</button>
            <button type="button" className="danger" disabled={deleting} onClick={() => void remove()}>{deleting ? "正在删除…" : "确认删除"}</button></div>
        </div>
      ) : <button type="button" className="ghost" onClick={() => setConfirming(true)}>删除记忆</button>}
    </article>
  );
}
