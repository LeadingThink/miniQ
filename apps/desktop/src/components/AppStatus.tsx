import {
  FileDiff,
  Globe2,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Sparkles,
} from "lucide-react";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { sessionStatusLabel } from "../sessionStatus";
import { ApprovalInboxButton } from "./ApprovalInbox";
import { OpenPreviewButton } from "./OpenPreviewButton";
import type { LocalFileTarget } from "../localFiles";
import "./AppStatus.css";

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
  const canDistill =
    currentSession &&
    !app.busy &&
    app.feed.messages.some((message) => message.role === "assistant");

  return (
    <div className="statusbar">
      <button
        type="button"
        className="statusbar-icon-button"
        title={`${app.navigation.sidebarCollapsed ? "显示" : "隐藏"}侧栏（⌘/Ctrl+B）`}
        aria-label={`${app.navigation.sidebarCollapsed ? "显示" : "隐藏"}侧栏`}
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
      <span
        className={`connection-state ${connected ? "connected" : app.connection.phase}`}
        title={
          connected ? "miniQ 后台服务运行正常" : "连接恢复后会自动同步会话"
        }
      >
        {connected ? (
          <span className="dot ok" />
        ) : (
          <LoaderCircle className="connection-spinner" size={13} />
        )}
        {connected
          ? `daemon v${health?.daemonVersion ?? "?"}`
          : app.connection.phase === "connecting"
            ? app.client.sshHost
              ? "正在连接 SSH 主机"
              : app.client.mode === "remote"
              ? "正在连接远程桌面"
              : "正在连接后台服务"
            : "连接中断，正在恢复"}
      </span>
      {app.client.sshHost && (
        <button type="button" className="ghost" title="切换执行主机" onClick={() => app.navigation.setShowSettings(true)}>
          SSH · {app.client.sshHost}
        </button>
      )}
      {currentSession && (
        <span className={`badge ${currentSession.status}`}>
          {sessionStatusLabel(currentSession.status)}
        </span>
      )}
      <span style={{ flex: 1 }} />
      <ApprovalInboxButton
        client={app.client}
        onOpenSession={app.actions.openSession}
      />
      {props.onToggleWorkbench && (
        <button
          type="button"
          className="statusbar-icon-button"
          title="任务、文件、网页和审阅"
          aria-label={props.workbenchOpen ? "隐藏工作面板" : "打开工作面板"}
          aria-expanded={props.workbenchOpen}
          onClick={props.onToggleWorkbench}
        >
          <PanelRight size={16} />
        </button>
      )}
      {app.client.mode === "local" && (
        <OpenPreviewButton
          workspacePath={
            currentSession?.workingDirectory ??
            app.catalog.currentWorkspace?.path
          }
          scope={app.preview.viewScope}
          onOpen={props.onOpenFile}
          onError={app.setError}
        />
      )}
      <button
        type="button"
        className="statusbar-icon-button"
        title={
          app.client.mode === "remote" ? "查看桌面网页记录" : "打开内置浏览器"
        }
        aria-label={
          app.client.mode === "remote" ? "查看桌面网页记录" : "打开内置浏览器"
        }
        disabled={app.client.mode === "remote" && !currentSession}
        onClick={props.onOpenBrowser}
      >
        <Globe2 size={16} />
      </button>
      {app.review.data.files.length > 0 && (
        <button
          type="button"
          className="ghost review-toggle"
          title="查看本会话的代码修改"
          onClick={props.onToggleReview}
        >
          <FileDiff size={16} />
          审阅 {app.review.data.files.length}
          <span className="diff-add">+{app.review.data.additions}</span>
          <span className="diff-delete">-{app.review.data.deletions}</span>
        </button>
      )}
      {canDistill && (
        <button
          type="button"
          className="ghost distill-button"
          title="保存为技能"
          aria-label="保存为技能"
          onClick={() => app.navigation.setShowDistill(true)}
        >
          <Sparkles size={16} /> <span>保存为技能</span>
        </button>
      )}
    </div>
  );
}

export function AppErrorBanner({ app }: { app: MiniqAppController }) {
  if (!app.error) return null;
  return (
    <div className="error-banner" role="alert">
      <span style={{ flex: 1 }}>{app.error}</span>
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
