import { ArrowLeft, Code2, FileImage, LoaderCircle, Search, Timer, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RpcClient } from "../rpc";
import type { Message } from "../types";
import { errorMessage } from "../errorMessage";
import "./MobileSessionSearch.css";

type SearchFilter = "all" | "code" | "attachments" | "recent";

const FILTERS: { id: SearchFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "code", label: "包含代码" },
  { id: "attachments", label: "图片/附件" },
  { id: "recent", label: "最近 7 天" },
];

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SEARCH_LIMIT = 50;

function snippet(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > 220 ? `${flat.slice(0, 220)}…` : flat;
}

function hasCode(content: string): boolean {
  return /```|`[^`\n]+`/.test(content);
}

function stamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Highlight every query hit inside a snippet without dropping the surrounding words. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const parts: string[] = [];
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  let index = 0;
  let hit = lower.indexOf(target);
  while (hit >= 0) {
    parts.push(text.slice(index, hit));
    parts.push(text.slice(hit, hit + needle.length));
    index = hit + needle.length;
    hit = lower.indexOf(target, index);
  }
  parts.push(text.slice(index));
  return (
    <>
      {parts.map((part, position) =>
        position % 2 === 1
          ? <mark className="mobile-session-search-hit" key={position}>{part}</mark>
          : <span key={position}>{part}</span>)}
    </>
  );
}

/** Full-screen in-conversation search for phones: capsule query, filter chips, result cards. */
export function MobileSessionSearch(props: {
  client: RpcClient;
  sessionId: string;
  query: string;
  onQuery: (value: string) => void;
  onClose: () => void;
  onLocate: (message: Message) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState<SearchFilter>("all");
  const [matches, setMatches] = useState<Message[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const query = props.query;

  useEffect(() => { input.current?.focus(); }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setMatches([]);
      setSearching(false);
      setError(null);
      setElapsed(null);
      return;
    }
    let stale = false;
    setSearching(true);
    setError(null);
    const started = performance.now();
    const timer = window.setTimeout(() => {
      props.client
        .call<{ matches: Message[] }>("session.search", { query: trimmed, limit: SEARCH_LIMIT })
        .then((result) => {
          if (stale) return;
          // This is an in-conversation search: keep only this session's records.
          setMatches((result.matches ?? []).filter((message) => message.sessionId === props.sessionId));
          setElapsed(performance.now() - started);
          setSearching(false);
        })
        .catch((cause) => {
          if (stale) return;
          setMatches([]);
          setSearching(false);
          setError(errorMessage(cause));
        });
    }, 200);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [props.client, props.sessionId, query]);

  const visible = useMemo(() => {
    const now = Date.now();
    return matches.filter((message) => {
      if (filter === "code") return hasCode(message.content);
      if (filter === "attachments") return Boolean(message.attachments?.length);
      if (filter === "recent") {
        const at = new Date(message.createdAt).getTime();
        return Number.isFinite(at) && now - at <= RECENT_WINDOW_MS;
      }
      return true;
    });
  }, [filter, matches]);

  return (
    <section className="mobile-session-search" aria-label="会话中搜索">
      <header className="mobile-session-search-head">
        <button
          type="button"
          className="mobile-session-search-back"
          aria-label="返回会话"
          onClick={props.onClose}
        >
          <ArrowLeft size={18} />
        </button>
        <div className="mobile-session-search-field">
          <Search size={15} aria-hidden="true" />
          <input
            ref={input}
            type="search"
            aria-label="搜索当前会话"
            placeholder="搜索当前会话"
            value={query}
            onChange={(event) => props.onQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                props.onClose();
              }
            }}
          />
          {query && (
            <button
              type="button"
              className="mobile-session-search-clear"
              aria-label="清空输入"
              onClick={() => props.onQuery("")}
            >
              <X size={12} />
            </button>
          )}
        </div>
        <button type="button" className="mobile-session-search-cancel" onClick={props.onClose}>取消</button>
      </header>

      <nav className="mobile-session-search-filters" aria-label="搜索过滤维度">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={filter === item.id}
            className={filter === item.id ? "active" : undefined}
            onClick={() => setFilter(item.id)}
          >
            {item.id === "code" && <Code2 size={13} aria-hidden="true" />}
            {item.id === "attachments" && <FileImage size={13} aria-hidden="true" />}
            {item.id === "recent" && <Timer size={13} aria-hidden="true" />}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <main className="mobile-session-search-results">
        {error && <p className="mobile-session-search-error" role="alert">{error}</p>}
        {!error && (
          <div className="mobile-session-search-meta" role="status" aria-live="polite">
            {searching && !matches.length ? (
              <span className="mobile-session-search-loading"><LoaderCircle size={13} className="activity-spinner" /> 正在搜索</span>
            ) : (
              <>
                <span>共找到 <strong>{visible.length}</strong> 条结果</span>
                {elapsed !== null && <span>用时 {(elapsed / 1000).toFixed(2)} 秒</span>}
              </>
            )}
          </div>
        )}
        {!query.trim() && (
          <p className="mobile-session-search-empty">输入关键词，搜索当前会话的消息、代码与附件。</p>
        )}
        {!!query.trim() && !searching && !error && visible.length === 0 && (
          <p className="mobile-session-search-empty">没有匹配的消息，换个关键词或筛选试试。</p>
        )}
        {visible.map((message) => (
          <article
            key={message.id}
            className="mobile-session-search-card"
            role="button"
            tabIndex={0}
            onClick={() => props.onLocate(message)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                props.onLocate(message);
              }
            }}
          >
            <div className="mobile-session-search-card-head">
              <span className={`dot ${message.role === "user" ? "user" : "assistant"}`} aria-hidden="true" />
              <span className="role">{message.role === "user" ? "你" : "miniQ"}</span>
              <time>{stamp(message.createdAt)}</time>
            </div>
            <p className="mobile-session-search-snippet">
              <Highlighted text={snippet(message.content)} query={query} />
            </p>
            {!!message.attachments?.length && (
              <div className="mobile-session-search-attachments">
                {message.attachments.map((attachment) => (
                  <span key={attachment.path}>
                    <FileImage size={12} aria-hidden="true" />
                    {attachment.name}
                  </span>
                ))}
              </div>
            )}
            <span className="mobile-session-search-open">定位至此条</span>
          </article>
        ))}
      </main>
    </section>
  );
}
