import {
  ChevronRight,
  Folder,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { errorMessage } from "../errorMessage";
import {
  ancestorDirectories,
  isInside,
  normalizePath,
  splitFileName,
  type TreeDirectory,
  type TreeEntry,
  visibleRows,
} from "../fileTreeModel";
import type { FileReadOptions, RemoteDirectory } from "../remoteFiles";
import { FileKindIcon } from "./FileKindIcon";
import "./WorkspaceFileTree.css";

/** Filtering scans unopened folders breadth-first within these bounds. */
const SCAN_LIMIT = 60;
const SCAN_DEPTH = 6;
const SCAN_SKIP = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  "vendor",
  "Pods",
  "DerivedData",
  "__pycache__",
  "venv",
]);
type ScanState = "idle" | "scanning" | "partial" | "done";

export { FileKindIcon };

export function WorkspaceFileTree({
  access,
  activePath,
  onOpen,
  filterRef,
  reveal,
}: {
  access: FileReadOptions;
  activePath?: string | null;
  onOpen: (path: string) => void;
  filterRef?: React.Ref<HTMLInputElement>;
  /** Expand, scroll to and focus a folder (e.g. a clicked breadcrumb). Bump nonce to repeat. */
  reveal?: { path: string; nonce: number } | null;
}) {
  const { client, sessionId } = access;
  const [root, setRoot] = useState<string | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [directories, setDirectories] = useState<Map<string, TreeDirectory>>(
    () => new Map(),
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState<string | null>(null);
  const generation = useRef(0);
  const pending = useRef(new Set<string>());
  const list = useRef<HTMLDivElement>(null);
  const directoriesRef = useRef(directories);
  directoriesRef.current = directories;
  const [scan, setScan] = useState<ScanState>("idle");

  const load = useCallback(
    async (path: string, after?: string): Promise<TreeEntry[]> => {
      const key = normalizePath(path);
      if (!client || !sessionId || pending.current.has(key)) return [];
      const token = generation.current;
      pending.current.add(key);
      setDirectories((previous) => {
        const next = new Map(previous);
        const current = next.get(key);
        next.set(key, {
          entries: current?.entries ?? [],
          nextCursor: current?.nextCursor ?? null,
          loading: true,
          error: null,
        });
        return next;
      });
      try {
        const page = await client.call<RemoteDirectory>("file.list", {
          sessionId,
          path,
          after,
        });
        if (token !== generation.current) return [];
        setDirectories((previous) => {
          const next = new Map(previous);
          const current = next.get(key);
          next.set(key, {
            entries: after ? [...(current?.entries ?? []), ...page.entries] : page.entries,
            nextCursor: page.nextCursor,
            loading: false,
            error: null,
          });
          return next;
        });
        return page.entries;
      } catch (cause) {
        if (token !== generation.current) return [];
        setDirectories((previous) => {
          const next = new Map(previous);
          const current = next.get(key);
          next.set(key, {
            entries: current?.entries ?? [],
            nextCursor: current?.nextCursor ?? null,
            loading: false,
            error: errorMessage(cause),
          });
          return next;
        });
        return [];
      } finally {
        if (token === generation.current) pending.current.delete(key);
      }
    },
    [client, sessionId],
  );

  const loadRoot = useCallback(async () => {
    generation.current += 1;
    pending.current.clear();
    const token = generation.current;
    setRootError(null);
    setDirectories(new Map());
    setExpanded(new Set());
    setRoot(null);
    if (!client || !sessionId) {
      setRootError("请先打开会话");
      return;
    }
    try {
      const page = await client.call<RemoteDirectory>("file.list", {
        sessionId,
        path: "",
      });
      if (token !== generation.current) return;
      const key = normalizePath(page.path);
      setDirectories(
        new Map([
          [key, { entries: page.entries, nextCursor: page.nextCursor, loading: false, error: null }],
        ]),
      );
      setRoot(key);
    } catch (cause) {
      if (token === generation.current) setRootError(errorMessage(cause));
    }
  }, [client, sessionId]);

  useEffect(() => {
    void loadRoot();
  }, [loadRoot]);

  // Reveal the active file: expand and load each ancestor folder.
  useEffect(() => {
    if (!root || !activePath) return;
    const ancestors = ancestorDirectories(root, activePath);
    if (!ancestors.length) return;
    setExpanded((previous) => {
      if (ancestors.every((dir) => previous.has(dir))) return previous;
      const next = new Set(previous);
      ancestors.forEach((dir) => next.add(dir));
      return next;
    });
    ancestors.forEach((dir) => {
      if (!directories.has(dir)) void load(dir);
    });
    // directories intentionally omitted: only re-run when the target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, activePath, load]);

  // Reveal a requested folder: clear the filter, expand it and its ancestors,
  // then scroll to and focus its row once it renders.
  const revealTarget = useRef<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  useEffect(() => {
    if (!root || !reveal) return;
    const target = normalizePath(reveal.path);
    if (!isInside(target, root)) return;
    setQuery("");
    const dirs = target === root ? [] : [...ancestorDirectories(root, target), target];
    setExpanded((previous) => {
      if (dirs.every((dir) => previous.has(dir))) return previous;
      const next = new Set(previous);
      dirs.forEach((dir) => next.add(dir));
      return next;
    });
    dirs.forEach((dir) => {
      if (!directoriesRef.current.has(dir)) void load(dir);
    });
    revealTarget.current = target;
    setRevealed(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, reveal?.path, reveal?.nonce, load]);
  useEffect(() => {
    if (!revealed) return;
    const timer = window.setTimeout(() => setRevealed(null), 1600);
    return () => window.clearTimeout(timer);
  }, [revealed]);

  // While filtering, walk unopened folders so matches deep in the project show up.
  const filtering = Boolean(query.trim());
  useEffect(() => {
    if (!root || !filtering) {
      setScan("idle");
      return;
    }
    let cancelled = false;
    const token = generation.current;
    setScan("scanning");
    void (async () => {
      const queue: Array<[string, number]> = [[root, 0]];
      let fetched = 0;
      while (queue.length) {
        if (cancelled || token !== generation.current) return;
        const [dir, depth] = queue.shift()!;
        let entries = directoriesRef.current.get(normalizePath(dir))?.entries;
        if (!entries) {
          if (fetched >= SCAN_LIMIT) {
            setScan("partial");
            return;
          }
          fetched += 1;
          entries = await load(dir);
        }
        if (depth >= SCAN_DEPTH) continue;
        for (const entry of entries) {
          if (entry.directory && !entry.name.startsWith(".") && !SCAN_SKIP.has(entry.name)) {
            queue.push([entry.path, depth + 1]);
          }
        }
      }
      if (!cancelled && token === generation.current) setScan("done");
    })();
    return () => {
      cancelled = true;
    };
  }, [root, filtering, load]);

  const rows = useMemo(
    () => (root ? visibleRows(root, directories, expanded, query) : []),
    [root, directories, expanded, query],
  );
  const active = activePath ? normalizePath(activePath) : null;
  const current =
    rows.find((row) => normalizePath(row.entry.path) === focused)?.entry.path ??
    rows.find((row) => normalizePath(row.entry.path) === active)?.entry.path ??
    rows[0]?.entry.path;

  useEffect(() => {
    const target = revealTarget.current;
    if (!target || !list.current) return;
    if (target === root) {
      revealTarget.current = null;
      list.current.scrollTo?.({ top: 0 });
      const first = rows[0]?.entry.path;
      if (first) focusRow(first);
      return;
    }
    if (!rows.some((row) => normalizePath(row.entry.path) === target)) return;
    revealTarget.current = null;
    setFocused(target);
    requestAnimationFrame(() => {
      const element = list.current?.querySelector<HTMLElement>(
        `[data-path="${cssEscape(rows.find((row) => normalizePath(row.entry.path) === target)!.entry.path)}"]`,
      );
      element?.scrollIntoView?.({ block: "nearest" });
      element?.focus({ preventScroll: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, root]);

  const toggle = (path: string, open?: boolean) => {
    const key = normalizePath(path);
    const willOpen = open ?? !expanded.has(key);
    setExpanded((previous) => {
      const next = new Set(previous);
      if (willOpen) next.add(key);
      else next.delete(key);
      return next;
    });
    if (willOpen && !directories.has(key)) void load(path);
  };

  const focusRow = (path: string | undefined) => {
    if (!path) return;
    setFocused(normalizePath(path));
    requestAnimationFrame(() =>
      list.current
        ?.querySelector<HTMLElement>(`[data-path="${cssEscape(path)}"]`)
        ?.focus(),
    );
  };

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const row = rows[index];
    const key = event.key;
    if (key === "ArrowDown") focusRow(rows[index + 1]?.entry.path);
    else if (key === "ArrowUp") focusRow(rows[index - 1]?.entry.path);
    else if (key === "Home") focusRow(rows[0]?.entry.path);
    else if (key === "End") focusRow(rows.at(-1)?.entry.path);
    else if (key === "ArrowRight" && row.entry.directory) {
      if (!row.expanded) toggle(row.entry.path, true);
      else focusRow(rows[index + 1]?.depth > row.depth ? rows[index + 1].entry.path : undefined);
    } else if (key === "ArrowLeft") {
      if (row.entry.directory && row.expanded) toggle(row.entry.path, false);
      else focusRow(row.parent ?? undefined);
    } else return;
    event.preventDefault();
  };

  const trailing = (dir: string, depth: number) => {
    const node = directories.get(normalizePath(dir));
    if (!node) return null;
    if (node.loading)
      return <div className="file-tree-note" style={{ paddingInlineStart: indent(depth) }} role="status">正在加载…</div>;
    if (node.error)
      return (
        <div className="file-tree-note error" style={{ paddingInlineStart: indent(depth) }} role="alert">
          {node.error}
          <button type="button" className="ghost" onClick={() => void load(dir)}>重试</button>
        </div>
      );
    if (node.nextCursor && !query.trim())
      return (
        <button
          type="button"
          className="file-tree-more"
          style={{ paddingInlineStart: indent(depth) }}
          onClick={() => void load(dir, node.nextCursor ?? undefined)}
        >
          加载更多
        </button>
      );
    if (!node.entries.length && depth > 0)
      return <div className="file-tree-note" style={{ paddingInlineStart: indent(depth) }}>空文件夹</div>;
    return null;
  };

  const items: React.ReactNode[] = [];
  rows.forEach((row, index) => {
    const { entry, depth } = row;
    const selected = !entry.directory && normalizePath(entry.path) === active;
    const { stem, tail } = splitFileName(entry.name);
    items.push(
      <div
        key={entry.path}
        role="treeitem"
        aria-level={depth + 1}
        aria-expanded={entry.directory ? row.expanded : undefined}
        aria-selected={selected}
        aria-disabled={entry.unavailable || undefined}
        data-path={entry.path}
        tabIndex={entry.path === current ? 0 : -1}
        className={`file-tree-row${selected ? " selected" : ""}${entry.unavailable ? " unavailable" : ""}${revealed && normalizePath(entry.path) === revealed ? " revealed" : ""}`}
        style={{ paddingInlineStart: indent(depth) }}
        title={entry.path}
        onFocus={() => setFocused(normalizePath(entry.path))}
        onClick={() => {
          setFocused(normalizePath(entry.path));
          if (entry.directory) toggle(entry.path);
          else if (!entry.unavailable) onOpen(entry.path);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (entry.directory) toggle(entry.path);
            else if (!entry.unavailable) onOpen(entry.path);
            return;
          }
          onKeyDown(event, index);
        }}
      >
        {entry.directory ? (
          <span className={`file-tree-chevron${row.expanded ? " open" : ""}`} aria-hidden>
            <ChevronRight size={14} />
          </span>
        ) : (
          <span className="file-tree-chevron-space" aria-hidden />
        )}
        {entry.directory ? (
          <Folder size={15} className="file-kind-icon file-kind-folder" aria-hidden />
        ) : (
          <FileKindIcon name={entry.name} />
        )}
        <span className="file-tree-name">
          <span className="file-tree-stem">{stem}</span>
          {tail && <span className="file-tree-tail">{tail}</span>}
        </span>
      </div>,
    );
    const next = rows[index + 1];
    if (row.expanded && (!next || next.depth <= depth)) {
      const note = trailing(entry.path, depth + 1);
      if (note) items.push(<div key={`${entry.path}#note`} role="none">{note}</div>);
    }
  });

  return (
    <nav className="workspace-file-tree" aria-label="项目文件树">
      <div className="file-tree-search">
        <Search size={14} aria-hidden />
        <input
          ref={filterRef}
          type="search"
          aria-label="筛选文件"
          placeholder="筛选文件…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              focusRow(rows[0]?.entry.path);
            } else if (event.key === "Enter" && query.trim()) {
              const first = rows.find((row) => !row.entry.directory);
              if (first) {
                event.preventDefault();
                onOpen(first.entry.path);
              }
            } else if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }
          }}
        />
        <button
          type="button"
          className="ghost file-tree-refresh"
          title="刷新文件树"
          aria-label="刷新文件树"
          onClick={() => void loadRoot()}
        >
          <RefreshCw size={13} />
        </button>
      </div>
      {rootError ? (
        <div className="file-tree-note error" role="alert">
          {rootError}
          <button type="button" className="ghost" onClick={() => void loadRoot()}>重试</button>
        </div>
      ) : !root ? (
        <div className="file-tree-note" role="status">正在加载项目文件…</div>
      ) : (
        <div className="file-tree-list" role="tree" aria-label="项目文件" ref={list}>
          {items}
          {trailing(root, 0)}
          {!rows.length && (
            <div className="file-tree-note">
              {!query.trim()
                ? "目录为空"
                : scan === "scanning"
                  ? "正在搜索项目文件…"
                  : "没有匹配的文件"}
            </div>
          )}
        </div>
      )}
      {query.trim() && (rows.length > 0 || scan === "partial") && (
        <p className="file-tree-hint" role="status">
          {scan === "scanning"
            ? "正在搜索更多目录…"
            : scan === "partial"
              ? "项目较大，仅搜索了部分目录；展开文件夹可继续查找"
              : "按 Enter 打开第一个匹配文件"}
        </p>
      )}
    </nav>
  );
}

function indent(depth: number) {
  return `${8 + depth * 14}px`;
}

function cssEscape(value: string) {
  return typeof CSS !== "undefined" && CSS.escape
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}
