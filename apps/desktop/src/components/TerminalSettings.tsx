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
}

const INSTALLERS = [
  {
    platform: "macOS",
    requirements: "支持 Apple Silicon 和 Intel。",
    command: "curl -fsSL https://oss.zaiwen.top/releases/miniq/install.sh | sh",
  },
  {
    platform: "Windows PowerShell",
    requirements: "支持 Windows 10 / 11 x64，请在 PowerShell 中执行。",
    command: "irm https://oss.zaiwen.top/releases/miniq/install.ps1 | iex",
  },
  {
    platform: "Linux / WSL",
    requirements: "支持 x86_64，需 glibc 2.31 或更高版本。当前可用版本为 0.1.54，请使用此指定版本命令安装或重装。",
    command: "curl -fsSL https://oss.zaiwen.top/releases/miniq/install.sh | MINIQ_VERSION=0.1.54 sh",
  },
];

function TerminalInstallGuide() {
  return <details>
    <summary>在其他电脑或服务器上安装</summary>
    <p className="settings-section-description">在目标电脑执行对应命令，自动下载官方版本，无需安装 Rust 或 Node.js。</p>
    {INSTALLERS.map(({ platform, requirements, command }) => <div className="terminal-install-platform" key={platform}>
      <h4>{platform}</h4>
      <p className="settings-section-description">{requirements}</p>
      <div className="terminal-install-command">
        <code>{command}</code>
        <CopyButton content={command} label={`复制 ${platform} 安装命令`} showLabel className="secondary" />
      </div>
    </div>)}
    <p className="settings-section-description">安装完成后重新打开终端，进入项目目录运行 <code>miniq</code>。首次使用按提示配置 API Key 并选择文本模型；本机已有桌面配置会直接复用。其他电脑需单独配置，WSL 与 Windows 使用独立的数据目录。</p>
  </details>;
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
      setMessage("终端命令已安装。请按下方说明开始使用。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setInstalling(false);
    }
  };

  return <section className="settings-section terminal-settings" aria-label="终端命令">
    <div className="settings-section-title"><Terminal size={15} /><span>终端命令</span></div>
    <p className="settings-section-description">在项目目录使用 miniq，与本机桌面共用服务配置和会话。下方按钮安装到本机，安装时不会中断正在执行的任务。</p>
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
    <p className="settings-section-description">安装完成后重新打开终端，进入项目目录，再运行 <code>miniq</code> 开始任务。</p>
    <ul className="terminal-command-help">
      <li>会话中输入 <code>/model</code> 选择模型，<code>/effort</code> 调整当前会话的推理强度。</li>
      <li><code>miniq resume</code>：选择并继续当前项目的历史会话。</li>
      <li><code>miniq update</code>：更新 macOS / Windows 终端程序；Linux / WSL 暂请使用下方指定版本的安装命令。</li>
      <li><code>miniq doctor</code>：检查终端、后台版本与依赖状态。</li>
    </ul>
    <TerminalInstallGuide />
    {log && <details><summary>安装详情</summary><pre className="terminal-install-log">{log}</pre></details>}
  </section>;
}
