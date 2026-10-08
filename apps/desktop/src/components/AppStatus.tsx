import { useContext, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import {
  FileDiff,
  Globe2,
  Laptop,
  LoaderCircle,
  MoreHorizontal,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Server,
  Settings,
  Sparkles,
  Wifi,
} from "lucide-react";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { sessionStatusLabel } from "../sessionStatus";
import { ApprovalInboxButton } from "./ApprovalInbox";
import { OpenPreviewButton } from "./OpenPreviewButton";
import type { LocalFileTarget } from "../localFiles";
import { menuPosition } from "../menuPosition";
import { moveMenuIndex } from "../menuNavigation";
import "./AppStatus.css";
import { REMOTE_CONNECTION_DETAILS_EVENT, RemoteConnectionStatus } from "./RemoteConnectionStatus";
import { RemoteDeviceBarContext } from "../remoteDeviceBar";

export function AppStatusBar(props: {
  app: MiniqAppController;
  onOpenBrowser: () => void;
  onToggleReview: () => void;
  onOpenFile: (target: LocalFileTarget) => void;
  onToggleWorkbench?: () => void;
  workbenchOpen?: boolean;
}) {
  const { app } = props;
  const { connected, health } = app.connection;
  const currentSession = app.catalog.currentSession;
  const currentWorkspace = app.catalog.currentWorkspace;
  const remote = app.client.mode === "remote";
  const deviceBar = useContext(RemoteDeviceBarContext);
  const canDistill = Boolean(
    currentSession &&
    !app.busy &&
    app.feed.messages.some((message) => message.role === "assistant"),
  );
  const sidebarLabel = `${app.navigation.sidebarCollapsed ? "显示" : "隐藏"}侧栏`;
  const browserLabel = remote ? "查看桌面网页记录" : "打开内置浏览器";
  const reviewFiles = app.review.data.files.length;
  const connectionLabel = connected
    ? `daemon v${health?.daemonVersion ?? "?"}`
    : app.connection.phase === "connecting"
      ? app.client.sshHost
        ? "正在连接 SSH 主机"
        : "正在连接后台服务"
      : "连接中断，正在恢复";
  const title = currentSession?.title || "新对话";
  const projectName = currentWorkspace?.name;

  const menuItems: OverflowItem[] = [
    ...(remote && deviceBar ? [
      { id: "switch-computer", label: "切换电脑", icon: <Laptop size={15} />, run: deviceBar.onSwitch },
      { id: "connection", label: "连接详情", icon: <Wifi size={15} />, run: () => window.dispatchEvent(new Event(REMOTE_CONNECTION_DETAILS_EVENT)) },
      ...(deviceBar.onAppearance ? [{ id: "appearance", label: "外观", icon: <Palette size={15} />, run: deviceBar.onAppearance }] : []),
    ] : []),
    { id: "browser", label: browserLabel, icon: <Globe2 size={15} />, disabled: remote && !currentSession, run: props.onOpenBrowser },
    ...(reviewFiles > 0 ? [{ id: "review", label: `审阅代码修改（${reviewFiles} 个文件）`, icon: <FileDiff size={15} />, run: props.onToggleReview }] : []),
    ...(canDistill ? [{ id: "distill", label: "保存为技能", icon: <Sparkles size={15} />, run: () => app.navigation.setShowDistill(true) }] : []),
    ...(app.client.sshHost && !remote ? [{ id: "ssh", label: `切换执行主机（SSH · ${app.client.sshHost}）`, icon: <Server size={15} />, run: () => app.navigation.setShowSettings(true) }] : []),
    { id: "settings", label: "设置", icon: <Settings size={15} />, shortcut: "⌘,", run: () => app.navigation.setShowSettings(true) },
  ];

  return (
    <div className="statusbar app-toolbar" data-tauri-drag-region>
      <button
        type="button"
        className="statusbar-icon-button"
        data-tooltip={`${sidebarLabel}（⌘/Ctrl+B）`}
        title={`${sidebarLabel}（⌘/Ctrl+B）`}
        aria-label={sidebarLabel}
        onClick={() =>
          app.navigation.setSidebarCollapsed(!app.navigation.sidebarCollapsed)
        }
      >
        {app.navigation.sidebarCollapsed ? (
          <PanelLeftOpen size={16} />
        ) : (
          <PanelLeftClose size={16} />
        )}
      </button>
      <div className="app-toolbar-title" data-tauri-drag-region>
        {remote ? (
          <RemoteConnectionStatus app={app} onToggleReview={props.onToggleReview} />
        ) : (
          <>
            <span className="app-toolbar-session" title={title} data-tauri-drag-region>{title}</span>
            {projectName && (
              <span className="app-toolbar-project" title={currentWorkspace?.path ?? projectName}>
                {projectName}
              </span>
            )}
            {currentSession && currentSession.status !== "idle" && (
              <span className={`badge ${currentSession.status}`}>
                {sessionStatusLabel(currentSession.status)}
              </span>
            )}
            {!connected && (
              <span
                className={`connection-state ${app.connection.phase}`}
                title="连接恢复后会自动同步会话"
                role="status"
              >
                <LoaderCircle className="connection-spinner" size={13} />
                {connectionLabel}
              </span>
            )}
          </>
        )}
      </div>
      <div className="app-toolbar-actions">
        <ApprovalInboxButton
          client={app.client}
          onOpenSession={app.actions.openSession}
        />
        {reviewFiles > 0 && (
          <button
            type="button"
            className="ghost review-toggle"
            title="查看本会话的代码修改"
            aria-label="查看本会话的代码修改"
            onClick={props.onToggleReview}
          >
            <FileDiff size={15} />
            <span className="diff-add">+{app.review.data.additions}</span>
            <span className="diff-delete">-{app.review.data.deletions}</span>
          </button>
        )}
        {app.client.mode === "local" && (
          <OpenPreviewButton
            workspacePath={
              currentSession?.workingDirectory ??
              currentWorkspace?.path
            }
            scope={app.preview.viewScope}
            onOpen={props.onOpenFile}
            onError={app.setError}
          />
        )}
        {props.onToggleWorkbench && (
          <button
            type="button"
            className={`statusbar-icon-button${props.workbenchOpen ? " active" : ""}`}
            data-tooltip="检查器：概览、审阅、预览和浏览器"
            title="检查器：概览、审阅、预览和浏览器"
            aria-label={props.workbenchOpen ? "隐藏检查器" : "显示检查器"}
            aria-pressed={props.workbenchOpen ?? false}
            onClick={props.onToggleWorkbench}
          >
            <PanelRight size={16} />
            <span className="statusbar-action-label">检查器</span>
          </button>
        )}
        <OverflowMenu items={menuItems} status={remote ? undefined : connectionLabel} connected={connected} />
      </div>
    </div>
  );
}

interface OverflowItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

function OverflowMenu({ items, status, connected }: { items: OverflowItem[]; status?: string; connected: boolean }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = menu.current?.offsetWidth ?? 240;
      const height = menu.current?.offsetHeight ?? 200;
      const next = menuPosition(
        { left: rect.right - width, top: rect.top, bottom: rect.bottom },
        { width, height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPosition(next);
    };
    place();
    const frame = window.requestAnimationFrame(() => {
      place();
      menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
    window.addEventListener("resize", place);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (event.key === "ArrowDown") next = moveMenuIndex(current, buttons.length, 1);
    else if (event.key === "ArrowUp") next = moveMenuIndex(current, buttons.length, -1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = buttons.length - 1;
    else if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") event.preventDefault();
      close(event.key === "Escape");
      return;
    } else return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`statusbar-icon-button${open ? " active" : ""}`}
        data-tooltip="更多操作"
        title="更多操作"
        aria-label="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={16} />
      </button>
      {open && createPortal(
        <div
          ref={menu}
          id={menuId}
          className="dropdown-menu app-toolbar-menu"
          role="menu"
          aria-label="更多操作"
          onKeyDown={onKeyDown}
          style={{
            position: "fixed",
            left: position?.left ?? 0,
            top: position?.top ?? 0,
            maxHeight: position?.maxHeight,
            visibility: position ? "visible" : "hidden",
          }}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="dropdown-item app-toolbar-menu-item"
              disabled={item.disabled}
              onClick={() => {
                close(false);
                item.run();
              }}
            >
              <span className="app-toolbar-menu-icon" aria-hidden="true">{item.icon}</span>
              <span className="app-toolbar-menu-label">{item.label}</span>
              {item.shortcut && <kbd className="app-toolbar-menu-shortcut" aria-hidden="true">{item.shortcut}</kbd>}
            </button>
          ))}
          {status && (
            <div className="app-toolbar-menu-status" role="presentation">
              <span className={`dot ${connected ? "ok" : ""}`} aria-hidden="true" />
              {status}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

export function AppErrorBanner({ app }: { app: MiniqAppController }) {
  if (!app.error) return null;
  return (
    <div className="error-banner" role="alert">
      <span style={{ flex: 1 }}>{app.error}</span>
      {app.client.mode === "remote" && !app.connection.connected && <button type="button" className="ghost" onClick={() => app.navigation.setShowSettings(true)}>连接设置</button>}
      <button
        type="button"
        className="banner-close"
        aria-label="关闭错误提示"
        onClick={app.dismissError}
      >
        ✕
      </button>
    </div>
  );
}
