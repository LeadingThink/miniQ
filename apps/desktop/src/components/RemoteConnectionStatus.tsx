import { ChevronDown, Laptop, LoaderCircle, RefreshCw, Server, Settings2, Wifi, WifiOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { useDesktopHost } from "../desktopHost";
import { hostKey } from "../hostWorkspace";
import { sessionStatusLabel } from "../sessionStatus";
import "./RemoteConnectionStatus.css";

export function RemoteConnectionStatus({ app, onToggleReview }: { app: MiniqAppController; onToggleReview?: () => void }) {
  const desktop = useDesktopHost();
  const [open, setOpen] = useState(false);
  const [online, setOnline] = useState(() => navigator.onLine);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const session = app.catalog.currentSession;
  const workspace = app.catalog.currentWorkspace;
  const { connected, retrying, phase, health } = app.connection;
  const machine = app.client.sshHost
    ? desktop?.catalogs[hostKey(app.client.sshHost)]?.label || app.client.sshHost
    : app.connection.deviceName || "远程桌面";
  const label = !online ? "当前设备网络已断开" : connected
    ? retrying ? "正在同步" : "已连接电脑"
    : phase === "connecting" ? "正在连接电脑" : "正在恢复连接";
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener("online", changed);
    window.addEventListener("offline", changed);
    return () => { window.removeEventListener("online", changed); window.removeEventListener("offline", changed); };
  }, []);
  useEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current;
    element.showModal();
    return () => { element.close(); trigger.current?.focus(); };
  }, [open]);
  useEffect(() => { setOpen(false); }, [desktop?.host]);
  const show = (button: HTMLButtonElement) => { trigger.current = button; setOpen(true); };
  return <>
    <button type="button" className="statusbar-identity" aria-label="查看完整会话标题与连接信息" aria-haspopup="dialog" onClick={(event) => show(event.currentTarget)}>
      <span><strong>{session?.title || "选择一个会话，继续工作"}</strong><small>{machine}{session ? ` · ${sessionStatusLabel(session.status)}` : ""}{workspace?.name ? ` · ${workspace.name}` : ""}</small></span><ChevronDown size={15} />
    </button>
    <button type="button" className={`connection-state remote-connection-trigger ${online && connected ? "connected" : "reconnecting"}`} aria-haspopup="dialog" aria-label={`${label}，查看连接详情`} title="查看连接状态、切换电脑或打开连接设置" onClick={(event) => show(event.currentTarget)}>
      {!online ? <WifiOff size={14} /> : connected ? <Wifi size={14} /> : <LoaderCircle className="connection-spinner" size={14} />}<span>{label}</span><ChevronDown size={12} />
    </button>
    {open && <dialog ref={dialog} className="remote-connection-dialog" aria-label="会话与连接信息" onCancel={(event) => { event.preventDefault(); setOpen(false); }}>
      <header><h2>会话与连接</h2><button type="button" className="icon-button" aria-label="关闭连接信息" onClick={() => setOpen(false)}><X size={20} /></button></header>
      <section className="remote-current-context">
        <h3>{session?.title || "尚未选择会话"}</h3>
        <dl><div><dt>执行电脑</dt><dd>{machine}</dd></div>{workspace && <div><dt>项目</dt><dd>{workspace.name}<small>{workspace.path}</small></dd></div>}{session && <div><dt>任务状态</dt><dd>{sessionStatusLabel(session.status)}</dd></div>}</dl>
        <div className="remote-connection-actions">
          {onToggleReview && app.review.data.files.length > 0 && <button type="button" className="secondary" onClick={() => { setOpen(false); onToggleReview(); }}>查看代码修改（{app.review.data.files.length}）</button>}
          {session && !app.busy && app.feed.messages.some((message) => message.role === "assistant") && <button type="button" className="secondary" onClick={() => { setOpen(false); app.navigation.setShowDistill(true); }}>保存为技能</button>}
        </div>
      </section>
      <section className="remote-connection-health" aria-label="连接状态">
        <strong role="status">{label}</strong>
        <p>{!online ? "请先恢复当前设备的网络。网络恢复后会自动尝试同步，你也可以手动重试。" : connected
          ? "远程内容通过端到端加密传输。离开页面或短暂断线，不会停止电脑上的任务。"
          : "请确认电脑上的 miniQ 已打开、允许远程连接，并使用同一个 Key。恢复连接后会同步当前进度，无需重新发送任务。"}</p>
        {health?.daemonVersion && <small>桌面版本 {health.daemonVersion}</small>}
        <div className="remote-connection-actions">
          <button type="button" className="secondary" disabled={!online || retrying} onClick={() => { void app.connection.retryConnection(); }}>
            <RefreshCw size={16} />{retrying ? "正在恢复或同步…" : connected ? "重新同步" : "重试连接"}
          </button>
          <button type="button" className="secondary" onClick={() => { setOpen(false); app.navigation.setShowSettings(true); }}><Settings2 size={16} />连接设置</button>
        </div>
        <small>更换 Key 或退出远程桌面，可在“连接设置”中操作。</small>
      </section>
      {desktop && desktop.registry.hosts.length > 0 && <section className="remote-machine-list" aria-label="切换执行电脑">
        <h3>切换执行电脑</h3><p>切换查看位置不会中断任务。</p>
        <button type="button" disabled={desktop.pending} aria-pressed={!desktop.host} onClick={() => { void desktop.selectHost(null); }}><Laptop size={18} /><span>已连接的桌面</span>{!desktop.host && <small>当前查看</small>}</button>
        {desktop.registry.hosts.map((host) => <button key={host.hostId} type="button" disabled={!online || desktop.pending} aria-pressed={desktop.host === host.hostId} onClick={() => { void desktop.selectHost(host.hostId); }}>
          <Server size={18} /><span>{host.label}<small>{host.hostId}</small></span><small>{desktop.host === host.hostId ? "当前查看" : host.state === "connected" ? "已连接" : host.state === "connecting" ? "连接中" : "点击连接"}</small>
        </button>)}
        {desktop.pending && <p role="status">正在切换电脑…</p>}
        {desktop.error && <p role="alert">未能切换电脑，请确认该电脑在线后重试。</p>}
      </section>}
    </dialog>}
  </>;
}
