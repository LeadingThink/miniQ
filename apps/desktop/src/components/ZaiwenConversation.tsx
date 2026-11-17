import { useMemo } from "react";
import { RefreshCw } from "lucide-react";
import type { ZaiwenHistory } from "../hooks/useZaiwenHistory";
import type { ZaiwenSession } from "../zaiwenAuth";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { useZaiwenChat } from "../hooks/useZaiwenChat";
import { useZaiwenCommands } from "../hooks/useZaiwenCommands";
import { useZaiwenModelControls } from "../hooks/useZaiwenModelControls";
import { readZaiwenTranscript, zaiwenMessageView, zaiwenSessionView } from "../zaiwenSessionView";
import { MarkdownLocalFilesContext } from "../markdownPolicy";
import { openExternalUrl } from "../externalLinks";
import { AppToolbar } from "./AppToolbar";
import { Composer } from "./Composer";
import { Timeline } from "./Timeline";
import { SessionModelControls } from "./SessionModelControls";
import { SessionMenu } from "./SessionMenu";
import { dispatchSessionToolbarAction } from "./TimelineToolbar";
import { useMobileLayout } from "../hooks/useMobileLayout";
import { ZaiwenMessageAssets } from "./ZaiwenMessageAssets";
import { EmptyState } from "./ui/EmptyState";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import "./ZaiwenHistory.css";

const noAction = async () => {};

/** Main-site data and transport, rendered by the original miniQ chat components. */
export function ZaiwenConversation({ session, history, app, onNavigate, onLogin, onToggleSidebar }: {
  app: MiniqAppController;
  onNavigate: () => void;
  session: ZaiwenSession;
  history: ZaiwenHistory;
  onLogin: () => void;
  onToggleSidebar: () => void;
}) {
  const chat = useZaiwenChat(session, history);
  const mobile = useMobileLayout();
  const picker = useZaiwenModelControls(chat);
  const page = history.messages;
  const selected = history.selected!;
  const sessionId = JSON.stringify(["zaiwen", session.user.uid, selected.id]);
  const commands = useZaiwenCommands(app, onNavigate, () => { void chat.stop(); }, sessionId);
  const messages = useMemo(() => chat.messages.map((item) => zaiwenMessageView(item, sessionId)), [chat.messages, sessionId]);
  const records = new Map(chat.messages.map((item) => [item.id, item]));
  const loginRequired = history.requiresLogin || chat.requiresLogin;
  const openUrl = (url: string) => {
    void openExternalUrl(url).catch((cause) => chat.setError(String(cause)));
  };
  const sessionMenu = <SessionMenu session={{ ...zaiwenSessionView(selected), id: sessionId }} messages={messages}
    onSearch={() => dispatchSessionToolbarAction(sessionId, "search")} />;
  return <main className="main" aria-label="在问会话">
    <AppToolbar sidebarCollapsed={app.navigation.sidebarCollapsed} onToggleSidebar={onToggleSidebar}
      title={<><span className="app-toolbar-session" title={selected.title || "未命名会话"} data-tauri-drag-region>{selected.title || "未命名会话"}</span>{!mobile && sessionMenu}</>}
      actions={<>{mobile && sessionMenu}<button type="button" className="statusbar-icon-button" disabled={chat.busy || page.loading || history.conversations.loading}
        aria-label="刷新会话记录" title="刷新会话记录" onClick={history.refresh}><RefreshCw size={17} /></button></>} />
    {loginRequired ? <EmptyState className="zaiwen-history-empty" title="在问登录已失效" description="重新登录后继续会话"
      action={<button type="button" className="ghost" onClick={onLogin}>重新登录在问</button>} /> : <>
      {page.error && <div className="zaiwen-history-notice" role="alert">{page.error}
        <button type="button" className="ghost" disabled={page.loading} onClick={page.refresh}>重试加载消息</button></div>}
      <div className="session-stage">
        <MarkdownLocalFilesContext.Provider value={false}>
          <Timeline sessionId={sessionId} title={selected.title || "未命名会话"} messages={messages}
            loading={page.loading && !page.items.length} loadingOlder={page.loading && !!page.items.length}
            historyCursor={page.cursor ? { at: "", id: page.cursor } : null} onLoadOlder={page.loadMore}
            toolCalls={[]} approvals={[]} questions={[]} plan={[]} artifacts={[]} queue={[]}
            streamingText="" turnProgress={null} busy={chat.busy}
            onResolveApproval={noAction} onResolveQuestion={noAction} onRollback={noAction}
            onSteerQueued={noAction} onRemoveQueued={noAction} onUpdateQueued={noAction}
            onOpenFile={() => chat.setError("主站会话无法访问本地工作区文件")} onOpenUrl={openUrl}
            onError={chat.setError}
            onReadExportHistory={(signal) => readZaiwenTranscript(session, selected.id, sessionId, signal)}
            renderMessageSupplement={(message) => {
              const record = records.get(message.id);
              return record && !(chat.busy && !record.content && record === chat.messages.at(-1)) ? <ZaiwenMessageAssets message={record} onOpenSite={() => openUrl("https://chat.zaiwenai.com/")} /> : null;
            }} />
        </MarkdownLocalFilesContext.Provider>
      </div>
    </>}
    {chat.error && <div className="zaiwen-history-notice" role="alert">{chat.error}</div>}
    <Composer autoFocus={!page.loading} busy={chat.busy} attachmentsEnabled={false}
      sessionId={sessionId} messages={messages} draftKey={`zaiwen.${session.user.uid}.${selected.id}`}
      onSend={chat.send} onCancel={() => { void chat.stop(); }} onError={chat.setError}
      sendBlocked={chat.busy || !chat.model || !!page.error || page.loading || loginRequired}
      sendBlockedReason={loginRequired ? "请重新登录在问" : page.error ? "请先重新加载会话记录" : chat.modelError ? "模型配置加载失败，请重试" : !chat.model ? "正在加载模型" : chat.stopping ? "正在停止回复…" : chat.busy ? "正在回复，可以先编辑下一条消息" : undefined}
      modelSlot={<SessionModelControls client={app.client} model={picker.model} catalog={picker.catalog} busy={chat.busy} />} />
    <KeyboardShortcutsDialog open={commands.showShortcuts} onClose={commands.closeShortcuts} />
  </main>;
}
