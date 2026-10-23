import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Archive,
  ChevronRight,
  GitBranch,
  MessageSquarePlus,
  Search,
  SlidersHorizontal,
  PencilLine,
  Pin,
} from "lucide-react";
import { menuPosition } from "../menuPosition";
import { isApplePlatform, SHORTCUTS, type ShortcutId } from "../shortcuts";
import { SESSION_RENAME_EVENT } from "../sessionMenuEvents";
import type { Message, Session } from "../types";
import "./SessionMenu.css";

interface Props {
  session: Session;
  messages: Message[];
  onRename: (title: string) => void | Promise<void>;
  onTogglePin: () => void;
  onNewSideChat: () => void;
  onSearch: () => void;
  onFork: (anchorMessageId: string) => void | Promise<unknown>;
  onArchive: () => void;
}

const FORK_SUBMENU_WIDTH = 264;

function shortcutLabel(id: ShortcutId): string {
  const definition = SHORTCUTS.find((shortcut) => shortcut.id === id);
  if (!definition) return "";
  const keys = isApplePlatform() ? definition.mac : definition.other;
  return isApplePlatform() ? keys.join("") : keys.join("+");
}

function forkCandidates(messages: Message[]): Message[] {
  return messages
    .filter(
      (message) =>
        message.role === "assistant" &&
        (message.assistantKind === "final" ||
          message.assistantKind === "interrupted" ||
          message.assistantKind === undefined),
    )
    .slice(-8)
    .reverse();
}

function replyLabel(message: Message): string {
  const line = message.content.replace(/\s+/g, " ").trim();
  if (!line) return "（空回复）";
  return line.length > 30 ? `${line.slice(0, 30)}…` : line;
}

/** Session overflow menu: rename, pin, side conversation, fork, archive. */
export function SessionMenu({
  session,
  messages,
  onRename,
  onTogglePin,
  onNewSideChat,
  onSearch,
  onFork,
  onArchive,
}: Props) {
  const [open, setOpen] = useState(false);
  const [submenuOpen, setSubmenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(session.title);
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const submenu = useRef<HTMLDivElement>(null);
  const forkItem = useRef<HTMLButtonElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const candidates = forkCandidates(messages);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = menu.current?.offsetWidth ?? 280;
      const height = menu.current?.offsetHeight ?? 300;
      setPosition(
        menuPosition(
          { left: rect.right - width, top: rect.top, bottom: rect.bottom },
          { width, height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    place();
    const frame = window.requestAnimationFrame(place);
    return () => window.cancelAnimationFrame(frame);
  }, [open, renaming]);

  useEffect(() => {
    if (!open) {
      setSubmenuOpen(false);
      setRenaming(false);
      return;
    }
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || submenu.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (submenuOpen) {
        setSubmenuOpen(false);
        forkItem.current?.focus();
      } else {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const reposition = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = menu.current?.offsetWidth ?? 280;
      const height = menu.current?.offsetHeight ?? 300;
      setPosition(
        menuPosition(
          { left: rect.right - width, top: rect.top, bottom: rect.bottom },
          { width, height },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", reposition);
    };
  }, [open, submenuOpen]);

  useEffect(() => {
    if (renaming) renameInput.current?.focus();
  }, [renaming]);

  useEffect(() => {
    const start = () => {
      setTitle(session.title);
      setOpen(true);
      setRenaming(true);
    };
    window.addEventListener(SESSION_RENAME_EVENT, start);
    return () => window.removeEventListener(SESSION_RENAME_EVENT, start);
  }, [session.title]);

  const openForkSubmenu = () => {
    const rect = forkItem.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(8, rect.left - FORK_SUBMENU_WIDTH - 6);
    const top = Math.max(8, Math.min(rect.top - 6, window.innerHeight - 320));
    setSubmenuPosition({ top, left });
    setSubmenuOpen(true);
  };

  const closeAll = () => {
    setOpen(false);
    setSubmenuOpen(false);
    setRenaming(false);
  };

  const run = (action: () => void | Promise<unknown>) => {
    closeAll();
    void action();
  };

  const submitRename = async () => {
    const next = title.trim();
    if (!next || next === session.title) {
      setRenaming(false);
      return;
    }
    await onRename(next);
    setOpen(false);
    setRenaming(false);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`statusbar-icon-button session-menu-trigger${open ? " active" : ""}`}
        data-tooltip="会话操作"
        title="会话操作"
        aria-label="会话操作"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          setTitle(session.title);
          setOpen((value) => !value);
        }}
      >
        <SlidersHorizontal size={16} />
      </button>
      {open && position && createPortal(
        <div
          id={menuId}
          ref={menu}
          className="session-menu"
          role="menu"
          style={{ position: "fixed", top: position.top, left: position.left, maxHeight: position.maxHeight }}
        >
          {renaming ? (
            <form
              className="session-menu-rename"
              onSubmit={(event) => {
                event.preventDefault();
                void submitRename();
              }}
            >
              <label htmlFor={`${menuId}-rename`}>重命名会话</label>
              <input
                id={`${menuId}-rename`}
                ref={renameInput}
                value={title}
                maxLength={120}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setRenaming(false);
                  }
                }}
              />
              <div className="session-menu-rename-actions">
                <button type="button" onClick={() => setRenaming(false)}>取消</button>
                <button type="submit" className="primary">保存</button>
              </div>
            </form>
          ) : (
            <>
              <button
                type="button"
                className="session-menu-item"
                role="menuitem"
                onClick={() => {
                  setTitle(session.title);
                  setRenaming(true);
                }}
              >
                <PencilLine className="session-menu-icon" size={15} />
                <span className="session-menu-label">重命名</span>
                <span className="session-menu-shortcut">{shortcutLabel("renameSession")}</span>
              </button>
              <button
                type="button"
                className="session-menu-item"
                role="menuitem"
                onClick={() => run(onTogglePin)}
              >
                <Pin className="session-menu-icon" size={15} />
                <span className="session-menu-label">{session.pinned ? "取消置顶" : "置顶"}</span>
                <span className="session-menu-shortcut">{shortcutLabel("togglePin")}</span>
              </button>

              <div className="session-menu-separator" role="separator" />

              <button
                type="button"
                className="session-menu-item"
                role="menuitem"
                onClick={() => run(onSearch)}
              >
                <Search className="session-menu-icon" size={15} />
                <span className="session-menu-label">搜索和筛选会话</span>
                <span className="session-menu-shortcut">{shortcutLabel("find")}</span>
              </button>
              <button
                type="button"
                className="session-menu-item"
                role="menuitem"
                onClick={() => run(onNewSideChat)}
              >
                <MessageSquarePlus className="session-menu-icon" size={15} />
                <span className="session-menu-label">新建侧边聊天</span>
                <span className="session-menu-shortcut">{shortcutLabel("newSideChat")}</span>
              </button>
              <button
                ref={forkItem}
                type="button"
                className="session-menu-item"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={submenuOpen}
                onClick={() => {
                  if (submenuOpen) setSubmenuOpen(false);
                  else openForkSubmenu();
                }}
              >
                <GitBranch className="session-menu-icon" size={15} />
                <span className="session-menu-label">分叉</span>
                <ChevronRight className="session-menu-chevron" size={14} />
              </button>

              <div className="session-menu-separator" role="separator" />

              <button
                type="button"
                className="session-menu-item"
                role="menuitem"
                onClick={() => run(onArchive)}
              >
                <Archive className="session-menu-icon" size={15} />
                <span className="session-menu-label">归档</span>
                <span className="session-menu-shortcut">{shortcutLabel("archiveSession")}</span>
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
      {open && submenuOpen && submenuPosition && createPortal(
        <div
          ref={submenu}
          className="session-menu session-submenu"
          role="menu"
          aria-label="选择分叉点"
          style={{ position: "fixed", top: submenuPosition.top, left: submenuPosition.left, width: FORK_SUBMENU_WIDTH }}
        >
          <p className="session-menu-heading">从哪条回复分叉</p>
          {candidates.length === 0 && <p className="session-menu-empty">暂无可分叉的回复</p>}
          {candidates.map((message) => (
            <button
              key={message.id}
              type="button"
              className="session-menu-item session-menu-reply"
              role="menuitem"
              onClick={() => run(() => onFork(message.id))}
            >
              <GitBranch className="session-menu-icon" size={14} />
              <span className="session-menu-label">{replyLabel(message)}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
