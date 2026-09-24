import { Download, RefreshCw, Terminal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../errorMessage";
import { CopyButton } from "./CopyButton";
import "./TerminalSettings.css";

interface TerminalStatus {
  path: string;
  installed: boolean;
  version: string | null;
  versionError: string | null;
  desktopVersion: string;
  installCommand: string;
}

export function TerminalSettings() {
  const [installation, setInstallation] = useState<TerminalStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setInstallation(await invoke<TerminalStatus>("terminal_install_status"));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const install = async () => {
    if (installing) return;
    setInstalling(true);
    setError(null);
    setMessage(null);
    setLog(null);
    try {
      const result = await invoke<{ status: TerminalStatus; log: string }>("install_terminal_command");
      setInstallation(result.status);
      setLog(result.log);
      setMessage("已安装。重新打开终端，输入 miniq 即可开始使用。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setInstalling(false);
    }
  };

  return <section className="settings-section terminal-settings" aria-label="终端命令">
    <div className="settings-section-title"><Terminal size={15} /><span>终端命令</span></div>
    <p className="settings-section-description">在终端中输入 miniq 即可使用。与本机桌面共用服务配置和会话，安装时不会中断正在执行的任务。</p>
    {installation && <div className="terminal-install-location">
      <strong>{installation.version ?? (installation.installed ? "已安装，版本读取失败" : "尚未安装终端命令")}</strong>
      <code>{installation.path}</code>
      <small>当前桌面版本 {installation.desktopVersion}</small>
      {installation.versionError && <p role="status">{installation.versionError}</p>}
    </div>}
    <div className="settings-actions">
      <button type="button" disabled={checking || installing} onClick={() => void install()}>
        <Download size={14} />{installing ? "正在下载并安装…" : installation?.installed ? "更新终端命令" : "安装终端命令"}
      </button>
      <button type="button" className="secondary" disabled={checking || installing} onClick={() => void refresh()}>
        <RefreshCw size={14} />{checking ? "正在检查…" : "刷新状态"}
      </button>
    </div>
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="terminal-install-error">{error}</p>}
    {installation && <details>
      <summary>在其他电脑或服务器上安装</summary>
      <p className="settings-section-description">在目标电脑的终端执行以下命令，自动下载适用版本，无需安装 Rust 或 Node.js。</p>
      <div className="terminal-install-command"><code>{installation.installCommand}</code>
        <CopyButton content={installation.installCommand} label="复制安装命令" showLabel className="secondary" />
      </div>
      <p className="settings-section-description">首次运行 miniq 按提示连接服务；以后运行 miniq update 更新，miniq resume 恢复会话。</p>
    </details>}
    {log && <details><summary>安装详情</summary><pre className="terminal-install-log">{log}</pre></details>}
  </section>;
}
