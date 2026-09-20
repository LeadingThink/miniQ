import { Monitor, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { useState } from "react";
import { errorMessage } from "../errorMessage";
import { validSshTarget, type HostList } from "../hostWorkspace";
import "./SshConnections.css";

export interface SshConnectionsProps extends HostList {
  activeHost: string | null;
  pending?: boolean;
  error?: string | null;
  canManage: boolean;
  onSelectHost: (host: string | null) => void;
  onSave: (host: string) => Promise<void>;
  onRemove: (host: string) => Promise<void>;
  onDisconnect: (host: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}

export function SshConnections(props: SshConnectionsProps) {
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perform = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const save = () => perform(async () => {
    const hostId = target.trim();
    if (!validSshTarget(hostId)) throw new Error("请输入 SSH 主机别名或 user@hostname，不要包含命令、空格或端口");
    await props.onSave(hostId); setTarget("");
  });
  const disabled = busy || props.pending;
  const discovered = props.discovered.filter((item) => !props.hosts.some((host) => host.hostId === item.alias));
  return <section className="ssh-connections" aria-label="SSH 连接">
    <div className="ssh-section-heading"><div><h3>连接其他电脑</h3><p>所有电脑的项目与会话保留在侧栏。切换查看位置不会停止任务。</p></div>
      <button type="button" className="icon-btn" title="刷新主机列表" disabled={disabled} onClick={() => void perform(props.onRefresh)}><RefreshCw size={16} /></button>
    </div>
    <button type="button" className={`ssh-host-row ${props.activeHost === null ? "active" : ""}`} disabled={disabled} onClick={() => props.onSelectHost(null)}>
      <Monitor size={18} /><span>{props.canManage ? "本机" : "已连接的桌面"}</span>{props.activeHost === null && <small>当前查看</small>}
    </button>
    {props.hosts.map((host) => <div className="ssh-host-row" key={host.hostId}>
      <button type="button" className="ssh-host-select" disabled={disabled} onClick={() => props.onSelectHost(host.hostId)} aria-label={`连接 ${host.label} ${host.hostId}`} aria-pressed={props.activeHost === host.hostId}>
        <Server size={18} /><span><strong>{host.label}</strong><small>{host.hostId}{host.version ? ` · ${host.version}` : ""}</small></span>
        <small>{host.state === "connected" ? "已连接" : host.state === "connecting" ? "连接中" : host.state === "error" ? "连接失败" : "未连接"}</small>
      </button>
      {host.state === "connected" && <button type="button" disabled={disabled} onClick={() => void perform(() => props.onDisconnect(host.hostId))}>断开</button>}
      {props.canManage && <button type="button" className="icon-btn" title={`移除 ${host.hostId}`} disabled={disabled} onClick={() => void perform(() => props.onRemove(host.hostId))}><Trash2 size={15} /></button>}
      {host.error && <p role="status">{host.error}</p>}
    </div>)}
    {props.canManage && <>
      {discovered.length > 0 && <div className="ssh-discovered"><p>本机 SSH 配置</p>{discovered.map((host) => <button key={host.alias} type="button" disabled={disabled} onClick={() => props.onSelectHost(host.alias)}>{host.alias}<small>{host.hostName}</small></button>)}</div>}
      <div className="ssh-add-host"><input aria-label="SSH 主机地址" placeholder="主机别名或 user@hostname" value={target} disabled={disabled} onChange={(event) => setTarget(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); void save(); } }} />
        <button type="button" disabled={disabled || !target.trim()} onClick={() => void save()}><Plus size={14} />添加电脑</button>
      </div>
      <details className="ssh-setup-help"><summary>首次连接准备</summary><ol>
        <li>在本机终端运行 <code>ssh 主机别名</code>，确认密钥登录和主机指纹。</li>
        <li>远端安装终端版的 <code>miniq</code> 与 <code>miniq-daemon</code>，放入 PATH。</li>
        <li>在远端运行 <code>miniq configure</code> 配置服务，再运行 <code>miniq doctor</code> 检查。</li>
        <li>在这里连接主机。远程使用那台电脑自身的项目、配置与模型 Key。</li>
      </ol><p>端口、私钥与跳板机请在 <code>~/.ssh/config</code> 中配置。不保存 SSH 密码，也不复制本机 API Key。</p>
        <a href="https://github.com/LeadingThink/miniQ-releases/releases" target="_blank" rel="noreferrer">下载终端版</a>
      </details>
    </>}
    {!props.canManage && <p className="ssh-help">可连接桌面已保存的 SSH 电脑。新增电脑或授权新目录，请在桌面端设置；移动端通信继续使用加密中继。</p>}
    {(error || props.error) && <p className="ssh-error" role="alert">{error ?? props.error}</p>}
  </section>;
}
