import { useEffect, useMemo, useRef, useState } from "react";
import type { Workspace } from "../types";

interface ProjectPickerProps {
  workspaces: Workspace[];
  selectedId: string | null;
  onSelect: (workspaceId: string) => void;
  onCreateBlank: (name: string) => void;
  onOpenFolder: () => void;
}

interface ProjectMenuProps {
  query: string;
  results: Workspace[];
  selectedId: string | null;
  naming: boolean;
  newName: string;
  onQueryChange: (query: string) => void;
  onSelect: (workspaceId: string) => void;
  onNamingChange: (naming: boolean) => void;
  onNewNameChange: (name: string) => void;
  onSubmitNewName: () => void;
  onOpenFolder: () => void;
}

function ProjectMenu(props: ProjectMenuProps) {
  return (
    <div className="mode-menu project-menu">
      <input
        className="project-search"
        placeholder="搜索项目"
        value={props.query}
        autoFocus
        onChange={(e) => props.onQueryChange(e.target.value)}
      />
      <div className="project-list">
        {props.results.map((workspace) => (
          <div
            key={workspace.id}
            className="mode-item"
            onClick={() => props.onSelect(workspace.id)}
          >
            <div className="mode-item-label">
              🗂 {workspace.name}
              {workspace.id === props.selectedId && (
                <svg
                  className="mode-check"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m5 13 4 4L19 7" />
                </svg>
              )}
            </div>
          </div>
        ))}
        {props.results.length === 0 && (
          <div className="sub" style={{ padding: "6px 10px" }}>
            没有匹配的项目
          </div>
        )}
      </div>
      <div className="project-menu-divider" />
      {props.naming ? (
        <div className="project-new-name">
          <input
            placeholder="项目名称"
            value={props.newName}
            autoFocus
            onChange={(e) => props.onNewNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") props.onSubmitNewName();
              if (e.key === "Escape") props.onNamingChange(false);
            }}
          />
          <button onClick={props.onSubmitNewName}>创建</button>
        </div>
      ) : (
        <div className="mode-item" onClick={() => props.onNamingChange(true)}>
          <div className="mode-item-label">＋ 新建空白项目</div>
        </div>
      )}
      <div className="mode-item" onClick={props.onOpenFolder}>
        <div className="mode-item-label">📂 使用现有文件夹</div>
      </div>
    </div>
  );
}

/** Codex-style project chooser chip: search existing projects, create a
 * blank one, or open an existing folder. */
export function ProjectPicker(props: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setNaming(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  const selected = props.workspaces.find((w) => w.id === props.selectedId) ?? null;
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? props.workspaces.filter((w) => w.name.toLowerCase().includes(q))
      : props.workspaces;
    return list.slice(0, 8);
  }, [query, props.workspaces]);

  const submitNewName = () => {
    const name = newName.trim();
    if (!name) return;
    props.onCreateBlank(name);
    setNewName("");
    setNaming(false);
    setOpen(false);
  };

  return (
    <div className="mode-select" ref={ref}>
      <button className="mode-trigger" onClick={() => setOpen((value) => !value)}>
        🗂 {selected ? selected.name : "选择项目"}
        <svg
          className="mode-caret"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <ProjectMenu
          query={query}
          results={results}
          selectedId={props.selectedId}
          naming={naming}
          newName={newName}
          onQueryChange={setQuery}
          onSelect={(workspaceId) => {
            props.onSelect(workspaceId);
            setOpen(false);
          }}
          onNamingChange={setNaming}
          onNewNameChange={setNewName}
          onSubmitNewName={submitNewName}
          onOpenFolder={() => {
            setOpen(false);
            props.onOpenFolder();
          }}
        />
      )}
    </div>
  );
}
