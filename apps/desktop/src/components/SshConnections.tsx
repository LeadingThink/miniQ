import { invoke } from "@tauri-apps/api/core";
import {
  Check,
  ExternalLink,
  Monitor,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import { isTauriRuntime } from "../runtime";
import "./SshConnections.css";

interface SshHost {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
}

interface SshConnectionsProps {
  activeHost: string | null;
  onSelectHost: (host: string | null) => void;
  pending?: boolean;
  error?: string | null;
}

const STORAGE_KEY = "miniq.ssh.saved-hosts";

function validTarget(value: string): boolean {
  const parts = value.split("@");
  if (parts.length > 2) return false;
  if (parts.length === 2 && !/^[\w.][\w.-]*$/.test(parts[0])) return false;
  const suppliedHost = parts.at(-1)!;
  const host =
    suppliedHost.startsWith("[") && suppliedHost.endsWith("]")
      ? suppliedHost.slice(1, -1)
      : suppliedHost;
  if (suppliedHost === host && /^[\w.][\w.-]*$/.test(host)) return true;
  if (!/^[\da-fA-F:.]+$/.test(host) || !host.includes(":")) return false;
  try {
    return new URL(`http://[${host}]/`).hostname.startsWith("[");
  } catch {
    return false;
  }
}

function loadSavedHosts(): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(STORAGE_KEY) ?? "[]",
    );
    return Array.isArray(value)
      ? [
          ...new Set(
            value.filter(
              (item): item is string =>
                typeof item === "string" && validTarget(item),
            ),
          ),
        ]
      : [];
  } catch {
    return [];
  }
}

function useSshDiscovery(native: boolean) {
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!native) return;
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<SshHost[]>("ssh_hosts");
      if (request === generation.current) setHosts(result);
    } catch (failure) {
      if (request === generation.current) setError(errorMessage(failure));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [native]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);
  return { hosts, loading, error, refresh };
}

function SshSetupHelp() {
  return (
    <details className="ssh-setup-help">
      <summary>首次连接准备</summary>
      <ol>
        <li>
          在本机终端运行 <code>ssh 主机别名</code>
          ，确认能登录目标电脑并核对主机指纹。支持 SSH 密钥与 ssh-agent。
        </li>
        <li>
          在远端 Linux 或 macOS 上安装终端版，将 <code>miniq</code> 与{" "}
          <code>miniq-daemon</code> 一起放入 PATH。
        </li>
        <li>
          在远端运行{" "}
          <code>
            miniq configure --base-url https://oneapi.zaiwenai.com/v1 --model
            MODEL_ID
          </code>
          （将 MODEL_ID 替换为模型名称），按提示输入那台电脑使用的 API
          Key，再运行 <code>miniq doctor</code> 检查。
        </li>
        <li>
          返回这里选择主机。项目、文件与任务均在所选电脑上执行；切换电脑只切换查看位置，不取消已有任务。
        </li>
      </ol>
      <p>
        自定义端口、私钥路径与跳板机请配置在 <code>~/.ssh/config</code>。miniQ
        使用本机 OpenSSH，不在这里收集密码或复制本机 API Key。
      </p>
      <a
        href="https://github.com/LeadingThink/miniQ-releases/releases"
        target="_blank"
        rel="noreferrer"
      >
        下载终端版（CLI 与后台程序） <ExternalLink size={12} />
      </a>
    </details>
  );
}

function SshHostRow({
  host,
  active,
  saved,
  pending,
  onSelect,
  onRemove,
}: {
  host: SshHost;
  active: boolean;
  saved: boolean;
  pending: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const address = host.hostName
    ? `${host.user ? `${host.user}@` : ""}${host.hostName}${host.port ? ` · 端口 ${host.port}` : ""}`
    : "手动添加的 SSH 主机";
  return (
    <li className="ssh-host-row" data-active={active}>
      <Server size={17} aria-hidden="true" />
      <div className="ssh-host-identity">
        <strong>{host.alias}</strong>
        <small>{address}</small>
      </div>
      <button
        type="button"
        className="secondary"
        disabled={pending || active}
        onClick={onSelect}
        aria-label={`连接 ${host.alias}`}
      >
        {active ? (
          <>
            <Check size={13} />
            当前
          </>
        ) : (
          "连接"
        )}
      </button>
      {saved && (
        <button
          type="button"
          className="icon-button"
          disabled={pending || active}
          onClick={onRemove}
          aria-label={`移除 ${host.alias}`}
          title={active ? "请先切换到此电脑，再移除此主机" : "只移除此主机入口"}
        >
          <Trash2 size={14} />
        </button>
      )}
    </li>
  );
}

function SshLocalHost({
  activeHost,
  onSelectHost,
  pending = false,
  native,
}: SshConnectionsProps & { native: boolean }) {
  return (
    <div className="ssh-host-row" data-active={!activeHost}>
      <Monitor size={17} aria-hidden="true" />
      <div className="ssh-host-identity">
        <strong>此电脑</strong>
        <small>本机的项目与会话</small>
      </div>
      <button
        type="button"
        className="secondary"
        disabled={!native || pending || !activeHost}
        onClick={() => onSelectHost(null)}
      >
        {activeHost ? (
          "返回此电脑"
        ) : (
          <>
            <Check size={13} />
            当前
          </>
        )}
      </button>
    </div>
  );
}

function SshHostInput({
  pending,
  onAdd,
}: {
  pending: boolean;
  onAdd: (host: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const add = () => {
    const target = draft.trim();
    if (pending || !target) return;
    if (!validTarget(target)) {
      setInputError(
        "请输入 SSH 主机别名或 user@hostname，不要填写 ssh 命令、网址或端口参数。端口请在 SSH 配置中设置。",
      );
      return;
    }
    setDraft("");
    setInputError(null);
    onAdd(target);
  };
  return (
    <>
      <label htmlFor="ssh-host-target">添加主机</label>
      <div className="ssh-host-add">
        <input
          id="ssh-host-target"
          value={draft}
          placeholder="例如 dev-server 或 user@hostname"
          autoComplete="off"
          spellCheck={false}
          disabled={pending}
          aria-invalid={!!inputError}
          aria-describedby={
            inputError ? "ssh-host-input-error" : "ssh-host-input-hint"
          }
          onChange={(event) => {
            setDraft(event.target.value);
            setInputError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              add();
            }
          }}
        />
        <button type="button" disabled={pending || !draft.trim()} onClick={add}>
          <Plus size={14} />
          添加并连接
        </button>
      </div>
      <small id="ssh-host-input-hint">
        使用已有 SSH 配置。此处只保存主机名称，不保存认证凭据。
      </small>
      {inputError && (
        <p id="ssh-host-input-error" className="ssh-error" role="alert">
          {inputError}
        </p>
      )}
    </>
  );
}

function useSavedSshHosts(discovered: SshHost[], activeHost: string | null) {
  const [saved, setSaved] = useState(loadSavedHosts);
  const [storageNotice, setStorageNotice] = useState<string | null>(null);
  const hosts = useMemo(() => {
    const result = new Map(discovered.map((host) => [host.alias, host]));
    for (const alias of [...saved, ...(activeHost ? [activeHost] : [])]) {
      if (!result.has(alias)) result.set(alias, { alias });
    }
    return [...result.values()].sort((a, b) => a.alias.localeCompare(b.alias));
  }, [discovered, saved, activeHost]);
  const remember = (next: string[]) => {
    setSaved(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      setStorageNotice(null);
    } catch {
      setStorageNotice(
        "本机存储不可用，主机列表仅保留到本次窗口关闭；连接仍可使用。",
      );
    }
  };
  return { saved, hosts, remember, storageNotice };
}

export function SshConnections({
  activeHost,
  onSelectHost,
  pending = false,
  error,
}: SshConnectionsProps) {
  const native = isTauriRuntime();
  const discovery = useSshDiscovery(native);
  const { saved, hosts, remember, storageNotice } = useSavedSshHosts(
    discovery.hosts,
    activeHost,
  );
  return (
    <section
      className="settings-section ssh-connections"
      aria-labelledby="ssh-connections-title"
      aria-busy={pending}
    >
      <div className="ssh-connections-heading">
        <h3 id="ssh-connections-title">
          <Server size={16} />
          SSH 连接
        </h3>
        <button
          type="button"
          className="secondary"
          disabled={!native || discovery.loading || pending}
          onClick={() => void discovery.refresh()}
          aria-label="刷新 SSH 主机"
        >
          <RefreshCw size={13} />
          {discovery.loading ? "读取中…" : "刷新"}
        </button>
      </div>
      <p className="settings-section-description">
        在 miniQ 中使用另一台电脑的项目和终端能力，连接由 SSH
        加密传输，无需中继。
      </p>
      <SshLocalHost
        native={native}
        activeHost={activeHost}
        onSelectHost={onSelectHost}
        pending={pending}
      />
      <p className="ssh-location" role="status">
        {pending
          ? "正在连接，请稍候…"
          : `当前执行位置：${activeHost ?? "此电脑"}`}
      </p>
      {error && (
        <p className="ssh-error" role="alert">
          连接失败：{error}
        </p>
      )}
      {!native ? (
        <p className="settings-section-description">
          SSH 连接需要 miniQ 桌面客户端；手机与网页请使用远程桌面连接。
        </p>
      ) : (
        <>
          {discovery.error && (
            <p className="ssh-error" role="alert">
              读取 SSH 配置失败：{discovery.error}
              。可以刷新重试，或在下方手动添加。
            </p>
          )}
          <ul className="ssh-host-list" aria-label="SSH 主机">
            {hosts.map((host) => (
              <SshHostRow
                key={host.alias}
                host={host}
                active={activeHost === host.alias}
                saved={saved.includes(host.alias)}
                pending={pending}
                onSelect={() => onSelectHost(host.alias)}
                onRemove={() =>
                  remember(saved.filter((alias) => alias !== host.alias))
                }
              />
            ))}
          </ul>
          {!discovery.loading && hosts.length === 0 && (
            <p className="settings-section-description">
              尚无主机。可从本机 SSH 配置读取具体的 Host 别名，也可以手动添加。
            </p>
          )}
          <SshHostInput
            pending={pending}
            onAdd={(target) => {
              remember([...new Set([...saved, target])]);
              onSelectHost(target);
            }}
          />
          {storageNotice && (
            <p className="settings-section-description" role="status">
              {storageNotice}
            </p>
          )}
          <SshSetupHelp />
        </>
      )}
    </section>
  );
}
