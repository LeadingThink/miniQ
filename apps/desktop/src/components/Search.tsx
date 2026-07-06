import { useEffect, useMemo, useRef, useState } from "react";
import type { Session, Workspace } from "../types";
import { relativeAge } from "../time";

/** Quick session finder: filters loaded sessions by title / project name. */
export function SearchOverlay(props: {
  sessions: Session[];
  workspaces: Workspace[];
  onSelectSession: (sessionId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wsName = (id: string) => props.workspaces.find((w) => w.id === id)?.name ?? "";

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? props.sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            wsName(s.workspaceId).toLowerCase().includes(q),
        )
      : props.sessions;
    return list.slice(0, 30);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, props.sessions, props.workspaces]);

  return (
    <div className="settings-overlay" onClick={props.onClose}>
      <div className="search-panel" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="search-input"
          placeholder="搜索会话..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results.length > 0) {
              props.onSelectSession(results[0].id);
              props.onClose();
            }
          }}
        />
        <div className="search-results">
          {results.length === 0 && <div className="sidebar-empty">没有匹配的会话。</div>}
          {results.map((s) => (
            <div
              key={s.id}
              className="search-result"
              onClick={() => {
                props.onSelectSession(s.id);
                props.onClose();
              }}
            >
              <span className="search-result-title">{s.title}</span>
              <span className="search-result-meta">
                {wsName(s.workspaceId)} · {relativeAge(s.updatedAt)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
