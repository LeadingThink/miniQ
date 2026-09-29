import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CalendarClock,
  FileSearch,
  Folder,
  History,
  MessageSquare,
  MessageSquarePlus,
  Plug,
  SearchX,
  Settings,
  Sparkles,
} from "lucide-react";
import type { RpcClient } from "../rpc";
import type { Message, Session, Workspace } from "../types";
import { relativeAge } from "../time";
import { clampMenuIndex, moveMenuIndex } from "../menuNavigation";
import { errorMessage } from "../errorMessage";
import { fuzzyMatch, highlightSegments } from "../fuzzyMatch";
import { EmptyState } from "./ui/EmptyState";
import { Spinner } from "./ui/Spinner";

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  icon: "new" | "settings" | "skills" | "mcp" | "schedule";
  run: () => void;
  /** Keyboard shortcut shown as a key cap, e.g. "⌘N". Falls back to `hint` when it looks like one. */
  shortcut?: string;
  /** Extra search terms (synonyms, English names). */
  keywords?: string[];
}

const COMMAND_ICONS = {
  new: MessageSquarePlus,
  settings: Settings,
  skills: Sparkles,
  mcp: Plug,
  schedule: CalendarClock,
} as const;

export const PALETTE_RECENT_KEY = "miniq.palette.recent";
const RECENT_LIMIT = 6;
const SESSION_LIMIT = 30;

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(PALETTE_RECENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
}

function rememberRecent(key: string) {
  try {
    const next = [key, ...readRecent().filter((existing) => existing !== key)].slice(0, RECENT_LIMIT);
    window.localStorage.setItem(PALETTE_RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage may be unavailable (private mode); recents are best-effort.
  }
}

function shortcutOf(command: PaletteCommand): string | undefined {
  if (command.shortcut) return command.shortcut;
  return command.hint && /^[⌘⌃⌥⇧]/.test(command.hint) ? command.hint : undefined;
}

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

interface PaletteEntry {
  key: string;
  section: string;
  title: string;
  indices: number[];
  subtitle?: ReactNode;
  icon: ReactNode;
  shortcut?: string;
  meta?: string;
  kind: "command" | "session" | "project" | "content";
  run: () => void;
}

/** Command palette (⌘K): fuzzy commands, sessions and projects + message content search. */
export function SearchOverlay(props: {
  sessions: Session[];
  workspaces: Workspace[];
  commands?: PaletteCommand[];
  client?: RpcClient;
  onSelectSession: (sessionId: string) => void;
  /** Optional project action; defaults to opening the project's most recent session. */
  onSelectWorkspace?: (workspaceId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recent] = useState(readRecent);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const q = query.trim();
  const workspaceName = (id: string) => props.workspaces.find((w) => w.id === id)?.name ?? "";
  const sessionTitle = (id: string) => props.sessions.find((s) => s.id === id)?.title ?? "会话";

  const entries = useMemo<PaletteEntry[]>(() => {
    const byRecency = (a: Session, b: Session) => b.updatedAt.localeCompare(a.updatedAt);
    const liveSessions = props.sessions.filter((session) => !session.archived).sort(byRecency);
    const latestSession = (workspaceId: string) =>
      liveSessions.find((session) => session.workspaceId === workspaceId);

    const commandEntry = (command: PaletteCommand, section: string, indices: number[] = []): PaletteEntry => {
      const Icon = COMMAND_ICONS[command.icon];
      const shortcut = shortcutOf(command);
      return {
        key: `cmd:${command.id}`,
        section,
        title: command.label,
        indices,
        icon: <Icon size={14} aria-hidden="true" />,
        shortcut,
        meta: shortcut ? undefined : command.hint,
        kind: "command",
        run: command.run,
      };
    };
    const sessionEntry = (session: Session, section: string, indices: number[] = []): PaletteEntry => ({
      key: `session:${session.id}`,
      section,
      title: session.title,
      indices,
      icon: <MessageSquare size={14} aria-hidden="true" />,
      meta: [workspaceName(session.workspaceId), relativeAge(session.updatedAt)].filter(Boolean).join(" · "),
      kind: "session",
      run: () => props.onSelectSession(session.id),
    });
    const projectEntry = (workspace: Workspace, section: string, indices: number[] = []): PaletteEntry | null => {
      const latest = latestSession(workspace.id);
      if (!props.onSelectWorkspace && !latest) return null;
      return {
        key: `project:${workspace.id}`,
        section,
        title: workspace.name,
        indices,
        icon: <Folder size={14} aria-hidden="true" />,
        meta: latest ? `最近：${latest.title}` : undefined,
        kind: "project",
        run: () => {
          if (props.onSelectWorkspace) props.onSelectWorkspace(workspace.id);
          else if (latest) props.onSelectSession(latest.id);
        },
      };
    };

    const commands = props.commands ?? [];

    if (!q) {
      const recentEntries: PaletteEntry[] = [];
      for (const key of recent) {
        const [kind, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
        let entry: PaletteEntry | null = null;
        if (kind === "cmd") {
          const command = commands.find((candidate) => candidate.id === id);
          if (command) entry = commandEntry(command, "最近使用");
        } else if (kind === "session") {
          const session = liveSessions.find((candidate) => candidate.id === id);
          if (session) entry = sessionEntry(session, "最近使用");
        } else if (kind === "project") {
          const workspace = props.workspaces.find((candidate) => candidate.id === id);
          if (workspace) entry = projectEntry(workspace, "最近使用");
        }
        if (entry) recentEntries.push(entry);
      }
      const shown = new Set(recentEntries.map((entry) => entry.key));
      return [
        ...recentEntries,
        ...commands.map((command) => commandEntry(command, "命令")).filter((entry) => !shown.has(entry.key)),
        ...liveSessions
          .slice(0, SESSION_LIMIT)
          .map((session) => sessionEntry(session, "最近会话"))
          .filter((entry) => !shown.has(entry.key)),
      ];
    }

    const ranked = <T,>(items: T[], text: (item: T) => string[]) =>
      items
        .map((item) => {
          let best: { score: number; indices: number[] } | null = null;
          text(item).forEach((candidate, position) => {
            const match = fuzzyMatch(candidate, q);
            if (!match) return;
            // Only the primary label (position 0) supplies highlight indices.
            const scored = { score: match.score - position * 10, indices: position === 0 ? match.indices : [] };
            if (!best || scored.score > best.score) best = scored;
          });
          return best ? { item, ...(best as { score: number; indices: number[] }) } : null;
        })
        .filter((hit): hit is { item: T; score: number; indices: number[] } => hit !== null)
        .sort((a, b) => b.score - a.score);

    return [
      ...ranked(commands, (command) => [command.label, ...(command.keywords ?? []), command.id]).map((hit) =>
        commandEntry(hit.item, "命令", hit.indices),
      ),
      ...ranked(
        props.sessions.filter((session) => !session.archived || session.title.toLowerCase().includes(q.toLowerCase())),
        (session) => [session.title, workspaceName(session.workspaceId)],
      )
        .slice(0, SESSION_LIMIT)
        .map((hit) => sessionEntry(hit.item, "会话", hit.indices)),
      ...ranked(props.workspaces, (workspace) => [workspace.name, workspace.path])
        .map((hit) => projectEntry(hit.item, "项目", hit.indices))
        .filter((entry): entry is PaletteEntry => entry !== null),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, recent, props.commands, props.sessions, props.workspaces, props.onSelectWorkspace]);

  // Content matches exclude sessions already shown as title matches.
  const contentSearch = useContentSearch(props.client, q);
  const items = useMemo<PaletteEntry[]>(() => {
    const shown = new Set(entries.filter((entry) => entry.kind === "session").map((entry) => entry.key.slice(8)));
    const content = contentSearch.matches
      .filter((message) => !shown.has(message.sessionId))
      .map<PaletteEntry>((message) => ({
        key: `content:${message.id}`,
        section: "消息内容",
        title: sessionTitle(message.sessionId),
        indices: [],
        subtitle: matchSnippet(message.content, q),
        icon: <FileSearch size={14} aria-hidden="true" />,
        meta: relativeAge(message.createdAt),
        kind: "content",
        run: () => props.onSelectSession(message.sessionId),
      }));
    return [...entries, ...content];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, contentSearch.matches]);

  const activate = (entry: PaletteEntry) => {
    if (entry.kind !== "content") rememberRecent(entry.key);
    props.onClose();
    entry.run();
  };

  useEffect(() => {
    setActiveIndex(0);
  }, [q]);

  useEffect(() => {
    setActiveIndex((index) => clampMenuIndex(index, items.length));
  }, [items.length]);

  useEffect(() => {
    if (activeIndex >= 0) optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
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
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setActiveIndex((index) => moveMenuIndex(index, items.length, 1));
    } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setActiveIndex((index) => moveMenuIndex(index, items.length, -1));
    } else if (e.key === "Home" && e.metaKey) {
      e.preventDefault();
      setActiveIndex(items.length > 0 ? 0 : -1);
    } else if (e.key === "End" && e.metaKey) {
      e.preventDefault();
      setActiveIndex(items.length - 1);
    } else if (e.key === "Enter" && items.length > 0) {
      e.preventDefault();
      activate(items[clampMenuIndex(activeIndex, items.length)]);
    }
  };

  const empty = items.length === 0 && !contentSearch.searching && !contentSearch.error;

  return (
    <div className="settings-overlay" onClick={props.onClose}>
      <div
        className="search-panel palette-panel"
        role="dialog"
        aria-modal="true"
        aria-label="搜索与命令"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="search-input"
          placeholder="搜索命令、会话、项目或消息内容…"
          value={query}
          role="combobox"
          aria-label="搜索会话、消息和命令"
          aria-autocomplete="list"
          aria-controls="search-palette-results"
          aria-expanded="true"
          aria-activedescendant={
            activeIndex >= 0 && items.length > 0 ? `search-palette-option-${activeIndex}` : undefined
          }
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
        />
        <div id="search-palette-results" className="search-results" role="listbox" aria-label="搜索结果">
          {items.map((entry, i) => (
            <PaletteRow
              key={entry.key}
              entry={entry}
              index={i}
              active={i === activeIndex}
              header={i === 0 || items[i - 1].section !== entry.section ? entry.section : undefined}
              optionRef={(element) => {
                optionRefs.current[i] = element;
              }}
              onHover={() => setActiveIndex(i)}
              onActivate={() => activate(entry)}
            />
          ))}
          {contentSearch.searching && (
            <div className="search-state" role="status">
              <Spinner size={12} /> 正在搜索消息内容…
            </div>
          )}
          {contentSearch.error && (
            <div className="search-state error" role="alert">消息内容搜索失败：{contentSearch.error}</div>
          )}
          {empty && (
            <EmptyState
              compact
              live
              icon={<SearchX size={20} />}
              title="没有匹配的结果"
              description={q ? `找不到与“${q}”相关的命令、会话或项目` : "还没有可显示的会话或命令"}
            />
          )}
        </div>
        <div className="palette-footer" aria-hidden="true">
          <span><kbd className="ui-kbd">↑</kbd><kbd className="ui-kbd">↓</kbd> 选择</span>
          <span><kbd className="ui-kbd">↵</kbd> 打开</span>
          <span><kbd className="ui-kbd">esc</kbd> 关闭</span>
          <span className="palette-footer-end"><kbd className="ui-kbd">⌘K</kbd> 切换</span>
        </div>
      </div>
    </div>
  );
}

function PaletteRow(props: {
  entry: PaletteEntry;
  index: number;
  active: boolean;
  header?: string;
  optionRef: (element: HTMLButtonElement | null) => void;
  onHover: () => void;
  onActivate: () => void;
}) {
  const { entry } = props;
  return (
    <>
      {props.header && (
        <div className="search-section" role="presentation">
          {props.header === "最近使用" && <History size={11} aria-hidden="true" />} {props.header}
        </div>
      )}
      <button
        ref={props.optionRef}
        id={`search-palette-option-${props.index}`}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={props.active}
        data-section={entry.section}
        className={`search-result ${entry.kind} ${props.active ? "active" : ""}`}
        onMouseMove={props.onHover}
        onClick={props.onActivate}
      >
        <span className="palette-row-icon">{entry.icon}</span>
        <span className="search-result-title">
          {highlightSegments(entry.title, entry.indices).map((segment, i) =>
            segment.match ? <mark key={i}>{segment.text}</mark> : <span key={i}>{segment.text}</span>,
          )}
          {entry.subtitle && <span className="search-snippet">{entry.subtitle}</span>}
        </span>
        {entry.meta && <span className="search-result-meta">{entry.meta}</span>}
        {entry.shortcut && <kbd className="ui-kbd palette-shortcut">{entry.shortcut}</kbd>}
      </button>
    </>
  );
}
