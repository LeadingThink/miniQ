import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Folder, FolderOpen, Plus } from "lucide-react";
import { moveMenuIndex } from "../menuNavigation";
import type { Workspace } from "../types";
import { Popover } from "./ui/Popover";

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
  activeIndex: number;
  onQueryChange: (query: string) => void;
  onSelect: (workspaceId: string) => void;
  onNamingChange: (naming: boolean) => void;
  onNewNameChange: (name: string) => void;
  onActiveIndexChange: (index: number) => void;
  onSubmitNewName: () => void;
  onOpenFolder: () => void;
}

function ProjectMenu(props: ProjectMenuProps) {
  return (
    <>
      <input
        className="project-search"
        placeholder="搜索项目"
        value={props.query}
        autoFocus
        onChange={(e) => props.onQueryChange(e.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            props.onActiveIndexChange(
              moveMenuIndex(
                props.activeIndex,
                props.results.length,
                event.key === "ArrowDown" ? 1 : -1,
              ),
            );
          } else if (
            event.key === "Enter" &&
            !event.nativeEvent.isComposing &&
            props.results.length > 0
          ) {
            event.preventDefault();
            props.onSelect(
              props.results[Math.max(0, props.activeIndex)]?.id ??
                props.results[0].id,
            );
          }
        }}
      />
      <div className="project-list" role="listbox" aria-label="项目">
        {props.results.map((workspace, index) => (
          <button
            key={workspace.id}
            type="button"
            role="option"
            aria-selected={workspace.id === props.selectedId}
            className={`mode-item${index === props.activeIndex ? " active" : ""}`}
            onMouseEnter={() => props.onActiveIndexChange(index)}
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
            <div className="mode-item-desc">{workspace.path}</div>
          </button>
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
              if (e.key === "Escape") {
                e.stopPropagation();
                props.onNamingChange(false);
              }
            }}
          />
          <button
            type="button"
            disabled={!props.newName.trim()}
            onClick={props.onSubmitNewName}
          >
            创建
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="mode-item"
          onClick={() => props.onNamingChange(true)}
        >
          <div className="mode-item-label">
            <Plus className="mode-icon" />
            新建空白项目
          </div>
        </button>
      )}
      <button type="button" className="mode-item" onClick={props.onOpenFolder}>
        <div className="mode-item-label">
          <FolderOpen className="mode-icon" />
          使用现有文件夹
        </div>
      </button>
    </>
  );
}

/** Codex-style project chooser chip: search existing projects, create a
 * blank one, or open an existing folder. */
export function ProjectPicker(props: ProjectPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setNaming(false);
    setQuery("");
    setActiveIndex(0);
  }, []);

  const selected =
    props.workspaces.find((w) => w.id === props.selectedId) ?? null;
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? props.workspaces.filter((w) =>
          `${w.name}\n${w.path}`.toLowerCase().includes(q),
        )
      : props.workspaces;
  }, [query, props.workspaces]);

  useEffect(() => {
    setActiveIndex(results.length > 0 ? 0 : -1);
  }, [query, results.length]);

  const submitNewName = () => {
    const name = newName.trim();
    if (!name) return;
    props.onCreateBlank(name);
    setNewName("");
    closeMenu();
  };

  return (
    <div className="mode-select">
      <button
        ref={triggerRef}
        type="button"
        className="mode-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? closeMenu() : setOpen(true))}
      >
        <Folder className="mode-icon" />
        {selected ? selected.name : "选择项目"}
        <ChevronDown className="mode-caret" />
      </button>
      <Popover
        open={open}
        anchorRef={triggerRef}
        onClose={closeMenu}
        label="选择项目"
        className="mode-menu project-menu"
      >
        <ProjectMenu
          query={query}
          results={results}
          selectedId={props.selectedId}
          naming={naming}
          newName={newName}
          activeIndex={activeIndex}
          onQueryChange={setQuery}
          onSelect={(workspaceId) => {
            props.onSelect(workspaceId);
            closeMenu();
          }}
          onNamingChange={setNaming}
          onNewNameChange={setNewName}
          onActiveIndexChange={setActiveIndex}
          onSubmitNewName={submitNewName}
          onOpenFolder={() => {
            closeMenu();
            props.onOpenFolder();
          }}
        />
      </Popover>
    </div>
  );
}
