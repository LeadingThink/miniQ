import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarClock,
  FileSearch,
  MessageSquarePlus,
  Plug,
  Settings,
  Sparkles,
} from "lucide-react";
import type { RpcClient } from "../rpc";
import type { Message, Session, Workspace } from "../types";
import { relativeAge } from "../time";
import { clampMenuIndex, moveMenuIndex } from "../menuNavigation";
import { errorMessage } from "../errorMessage";

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  icon: "new" | "settings" | "skills" | "mcp" | "schedule";
  run: () => void;
}

const COMMAND_ICONS = {
  new: MessageSquarePlus,
  settings: Settings,
  skills: Sparkles,
  mcp: Plug,
  schedule: CalendarClock,
} as const;

/** Trim a matched message down to a snippet around the first hit. */
function matchSnippet(content: string, query: string): string {
  const index = content.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return content.slice(0, 80);
  const start = Math.max(0, index - 30);
  const snippet = content.slice(start, start + 90).replace(/\s+/g, " ");
  return (start > 0 ? "…" : "") + snippet;
}

/** Debounced full-text search across message contents via the daemon. */
function useContentSearch(client: RpcClient | undefined, query: string) {
  const [matches, setMatches] = useState<Message[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client || query.length < 2) {
      setMatches([]);
      setSearching(false);
      setError(null);
      return;
    }
    let stale = false;
    setSearching(true);
    setError(null);
    const timer = window.setTimeout(() => {
      client
        .call<{ matches: Message[] }>("session.search", { query, limit: 10 })
        .then((result) => {
          if (!stale) {
            setMatches(result.matches);
            setSearching(false);
          }
        })
        .catch((cause) => {
          if (!stale) {
            setMatches([]);
            setSearching(false);
            setError(errorMessage(cause));
          }
        });
    }, 200);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [client, query]);

  return { matches, searching, error };
}

interface PaletteItem {
  key: string;
  run: () => void;
}

/** Command palette (⌘K): commands + title search + message content search. */
export function SearchOverlay(props: {
  sessions: Session[];
  workspaces: Workspace[];
  commands?: PaletteCommand[];
  client?: RpcClient;
  onSelectSession: (sessionId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const wsName = (id: string) => props.workspaces.find((w) => w.id === id)?.name ?? "";
  const sessionTitle = (id: string) =>
    props.sessions.find((s) => s.id === id)?.title ?? "会话";

  const q = query.trim().toLowerCase();

  const commands = useMemo(() => {
    const all = props.commands ?? [];
    if (!q) return all;
    return all.filter((c) => c.label.toLowerCase().includes(q));
  }, [props.commands, q]);

  const sessions = useMemo(() => {
    const list = q
      ? props.sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            wsName(s.workspaceId).toLowerCase().includes(q),
        )
      : props.sessions.filter((s) => !s.archived);
    return list.slice(0, 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, props.sessions, props.workspaces]);

  // Content matches exclude sessions already shown as title matches.
  const contentSearch = useContentSearch(props.client, query.trim());
  const contentMatches = useMemo(() => {
    const shown = new Set(sessions.map((s) => s.id));
    return contentSearch.matches.filter((m) => !shown.has(m.sessionId));
  }, [contentSearch.matches, sessions]);

  const items: PaletteItem[] = useMemo(
    () => [
      ...commands.map((c) => ({
        key: `cmd:${c.id}`,
        run: () => {
          props.onClose();
          c.run();
        },
      })),
      ...sessions.map((s) => ({
        key: `session:${s.id}`,
        run: () => {
          props.onClose();
          props.onSelectSession(s.id);
        },
      })),
      ...contentMatches.map((m) => ({
        key: `content:${m.id}`,
        run: () => {
          props.onClose();
          props.onSelectSession(m.sessionId);
        },
      })),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commands, sessions, contentMatches],
  );

  useEffect(() => {
    setActiveIndex(items.length > 0 ? 0 : -1);
  }, [query]);

  useEffect(() => {
    setActiveIndex((index) => clampMenuIndex(index, items.length));
  }, [items.length]);

  useEffect(() => {
    if (activeIndex >= 0) {
      optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((index) => moveMenuIndex(index, items.length, 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((index) => moveMenuIndex(index, items.length, -1));
    } else if (
      e.key === "Enter" &&
      items.length > 0 &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      items[clampMenuIndex(activeIndex, items.length)].run();
    }
  };

  let index = -1;
  const nextIndex = () => {
    index += 1;
    return index;
  };

  return (
    <div className="settings-overlay" onClick={props.onClose}>
      <div
        className="search-panel"
        role="dialog"
        aria-modal="true"
        aria-label="搜索与命令"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="search-input"
          placeholder="搜索会话、消息内容,或输入命令..."
          value={query}
          role="combobox"
          aria-label="搜索会话、消息和命令"
          aria-autocomplete="list"
          aria-controls="search-palette-results"
          aria-expanded="true"
          aria-activedescendant={
            activeIndex >= 0 ? `search-palette-option-${activeIndex}` : undefined
          }
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
        />
        <div
          id="search-palette-results"
          className="search-results"
          role="listbox"
          aria-label="搜索结果"
        >
          {contentSearch.searching && (
            <div className="search-state" role="status">正在搜索消息内容...</div>
          )}
          {contentSearch.error && (
            <div className="search-state error" role="alert">消息内容搜索失败：{contentSearch.error}</div>
          )}
          {items.length === 0 && !contentSearch.searching && !contentSearch.error && (
            <div className="sidebar-empty">没有匹配的结果。</div>
          )}
          {commands.length > 0 && <div className="search-section">命令</div>}
          {commands.map((c) => {
            const i = nextIndex();
            const Icon = COMMAND_ICONS[c.icon];
            return (
              <button
                ref={(element) => {
                  optionRefs.current[i] = element;
                }}
                id={`search-palette-option-${i}`}
                key={c.id}
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                className={`search-result command ${i === activeIndex ? "active" : ""}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => {
                  props.onClose();
                  c.run();
                }}
              >
                <span className="search-result-title">
                  <Icon size={14} /> {c.label}
                </span>
                {c.hint && <span className="search-result-meta">{c.hint}</span>}
              </button>
            );
          })}
          {sessions.length > 0 && <div className="search-section">会话</div>}
          {sessions.map((s) => {
            const i = nextIndex();
            return (
              <button
                ref={(element) => {
                  optionRefs.current[i] = element;
                }}
                id={`search-palette-option-${i}`}
                key={s.id}
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                className={`search-result ${i === activeIndex ? "active" : ""}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => {
                  props.onClose();
                  props.onSelectSession(s.id);
                }}
              >
                <span className="search-result-title">{s.title}</span>
                <span className="search-result-meta">
                  {wsName(s.workspaceId)} · {relativeAge(s.updatedAt)}
                </span>
              </button>
            );
          })}
          {contentMatches.length > 0 && <div className="search-section">消息内容</div>}
          {contentMatches.map((m) => {
            const i = nextIndex();
            return (
              <button
                ref={(element) => {
                  optionRefs.current[i] = element;
                }}
                id={`search-palette-option-${i}`}
                key={m.id}
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                className={`search-result content ${i === activeIndex ? "active" : ""}`}
                onMouseEnter={() => setActiveIndex(i)}
                onClick={() => {
                  props.onClose();
                  props.onSelectSession(m.sessionId);
                }}
              >
                <span className="search-result-title">
                  <FileSearch size={14} /> {sessionTitle(m.sessionId)}
                  <span className="search-snippet">{matchSnippet(m.content, query)}</span>
                </span>
                <span className="search-result-meta">{relativeAge(m.createdAt)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
