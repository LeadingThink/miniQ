import { Check, ExternalLink, KeyRound, MonitorSmartphone, Palette, Server, Wifi, WifiOff, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import { openExternalUrl } from "../externalLinks";
import type { RpcClient } from "../rpc";
import { THEMES, type ThemeId } from "../theme";
import { clearRemoteCredentials, DEFAULT_RELAY_URL } from "../remoteAccess";

export const ZAIWEN_API_PORTAL_URL = "https://platform.zaiwenai.com/";
export const ZAIWEN_API_BASE_URL = "https://oneapi.zaiwenai.com/v1";

interface ProviderView {
  baseUrl: string;
  model: string;
  apiProtocol: ApiProtocol;
  hasApiKey: boolean;
}

type ApiProtocol = "auto" | "chat_completions" | "responses" | "anthropic_messages";

interface SettingsView {
  provider: ProviderView | null;
  remoteAccess: {
    enabled: boolean;
    relayUrl: string;
    deviceName: string;
    deviceId: string;
  };
  remoteStatus: {
    state: "disabled" | "waiting_for_key" | "connecting" | "connected" | "reconnecting";
    relayUrl: string;
    mobileClients: number;
    lastError?: string;
  };
}

interface SettingsPanelProps {
  client: RpcClient;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  onClose: () => void;
}

export function SettingsPanel(props: SettingsPanelProps) {
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiProtocol, setApiProtocol] = useState<ApiProtocol>("auto");
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [remoteEnabled, setRemoteEnabled] = useState(false);
  const [relayUrl, setRelayUrl] = useState(DEFAULT_RELAY_URL);
  const [deviceName, setDeviceName] = useState("我的电脑");
  const [remoteStatus, setRemoteStatus] = useState<SettingsView["remoteStatus"] | null>(null);
  const panelRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    void props.client
      .call<SettingsView>("settings.get")
      .then((res) => {
        if (res.provider) {
          setBaseUrl(res.provider.baseUrl);
          setModel(res.provider.model);
          setApiProtocol(res.provider.apiProtocol ?? "auto");
          setHasKey(res.provider.hasApiKey);
        }
        if (res.remoteAccess) {
          setRemoteEnabled(res.remoteAccess.enabled);
          setRelayUrl(res.remoteAccess.relayUrl);
          setDeviceName(res.remoteAccess.deviceName);
        }
        setRemoteStatus(res.remoteStatus ?? null);
        setStatus(null);
      })
      .catch((error) => setStatus(`读取设置失败：${errorMessage(error)}`))
      .finally(() => setLoading(false));
  }, [props.client]);

  useEffect(() => {
    if (loading || props.client.mode !== "local" || !remoteEnabled) return;
    let cancelled = false;
    let timer: number | null = null;
    const refreshRemoteStatus = async () => {
      try {
        const result = await props.client.call<SettingsView>("settings.get");
        if (!cancelled) setRemoteStatus(result.remoteStatus ?? null);
      } catch {
        // The main connection status reports failures; polling resumes after reconnect.
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void refreshRemoteStatus(), 2_000);
      }
    };
    void refreshRemoteStatus();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [loading, props.client, remoteEnabled]);

  useEffect(() => {
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      } else if (event.key === "Tab" && panelRef.current) {
        const controls = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (controls.length === 0) return;
        const first = controls[0];
        const last = controls.at(-1)!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [props.onClose]);

  const save = async () => {
    if (saving) return;
    setStatus(null);
    setSaving(true);
    try {
      const params: Record<string, unknown> = {};
      if (baseUrl.trim() && model.trim()) {
        const provider: Record<string, unknown> = {
          baseUrl: baseUrl.trim(),
          model: model.trim(),
          apiProtocol,
        };
        if (apiKey) provider.apiKey = apiKey;
        params.provider = provider;
      }
      params.remoteAccess = {
        enabled: remoteEnabled,
        relayUrl: relayUrl.trim(),
        deviceName: deviceName.trim(),
      };
      const res = await props.client.call<SettingsView>("settings.update", params);
      setHasKey(res.provider?.hasApiKey ?? false);
      setApiKey("");
      setRemoteStatus(res.remoteStatus ?? null);
      setStatus("已保存");
    } catch (e) {
      setStatus(`保存失败：${errorMessage(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const openZaiwenApiPortal = async () => {
    setStatus(null);
    try {
      await openExternalUrl(ZAIWEN_API_PORTAL_URL);
    } catch (error) {
      setStatus(`无法打开在问商用 API：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div className="settings-overlay" onClick={props.onClose}>
      <form
        ref={panelRef}
        tabIndex={-1}
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="settings-header">
          <div>
            <h2 id="settings-title">设置</h2>
            <p>调整 miniQ 的外观和模型服务</p>
          </div>
          <button type="button" className="icon-button" title="关闭设置" aria-label="关闭设置" onClick={props.onClose}>
            <X size={16} />
          </button>
        </div>

        <section className="settings-section">
          <div className="settings-section-title">
            <Palette size={15} />
            <span>外观主题</span>
          </div>
          <div className="theme-grid" role="radiogroup" aria-label="外观主题">
            {THEMES.map((theme) => {
              const selected = props.theme === theme.id;
              return (
                <button
                  key={theme.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`theme-option${selected ? " selected" : ""}`}
                  onClick={() => props.onThemeChange(theme.id)}
                >
                  <span className="theme-swatches" aria-hidden="true">
                    {theme.swatches.map((color) => (
                      <span key={color} style={{ backgroundColor: color }} />
                    ))}
                  </span>
                  <span className="theme-copy">
                    <strong>{theme.name}</strong>
                    <small>{theme.description}</small>
                  </span>
                  {selected && <Check className="theme-check" size={15} />}
                </button>
              );
            })}
          </div>
        </section>

        {props.client.mode === "remote" ? (
          <section className="settings-section provider-settings">
            <div className="settings-section-title"><MonitorSmartphone size={15} /><span>远程桌面</span></div>
            <div className="remote-access-summary connected">
              <Wifi size={17} />
              <div><strong>端到端加密连接已建立</strong><p>当前页面操作由桌面 miniQ 执行，relay 无法读取会话内容。</p></div>
            </div>
            <button type="button" className="secondary" onClick={() => { void clearRemoteCredentials().finally(() => window.location.reload()); }}>
              <WifiOff size={14} />退出远程桌面
            </button>
          </section>
        ) : <>
        <section className="settings-section provider-settings">
          <div>
            <div className="settings-section-title">模型服务</div>
            <p className="settings-section-description">支持 OpenAI Chat、Responses 与 Anthropic Messages</p>
          </div>
          <label>
            Base URL
            <input
              value={baseUrl}
              disabled={loading || saving}
              inputMode="url"
              spellCheck={false}
              placeholder="https://api.openai.com/v1"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label>
            Model
            <input
              value={model}
              disabled={loading || saving}
              spellCheck={false}
              placeholder="gpt-4o-mini"
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
          <label>
            API 协议
            <select
              value={apiProtocol}
              disabled={loading || saving}
              onChange={(event) => setApiProtocol(event.target.value as ApiProtocol)}
            >
              <option value="auto">自动识别</option>
              <option value="responses">OpenAI Responses</option>
              <option value="anthropic_messages">Anthropic Messages</option>
              <option value="chat_completions">OpenAI Chat Completions</option>
            </select>
          </label>
          <label>
            API key {hasKey && <span className="badge">已保存</span>}
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              disabled={loading || saving}
              placeholder={hasKey ? "留空以保留当前密钥" : "sk-..."}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
          <div className="provider-purchase">
            <div className="provider-purchase-copy">
              <span className="provider-purchase-icon" aria-hidden="true">
                <KeyRound size={16} />
              </span>
              <div>
                <strong>需要 API Key？</strong>
                <p>前往在问商用 API 获取 Key，购买后即可用于 miniQ。</p>
              </div>
            </div>
            <div className="provider-purchase-actions">
              <a
                href={ZAIWEN_API_PORTAL_URL}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  event.preventDefault();
                  void openZaiwenApiPortal();
                }}
              >
                获取在问 API Key
                <ExternalLink size={13} />
              </a>
              <button
                type="button"
                className="secondary provider-base-url-button"
                onClick={() => {
                  setBaseUrl(ZAIWEN_API_BASE_URL);
                  setApiProtocol("auto");
                  setStatus("已填入在问 API 地址，请继续填写模型名称和 API Key");
                }}
              >
                <Server size={13} />
                填入接口地址
              </button>
            </div>
          </div>
        </section>
        <section className="settings-section provider-settings">
          <div>
            <div className="settings-section-title"><MonitorSmartphone size={15} /><span>移动端与远程桌面</span></div>
            <p className="settings-section-description">开启后，使用同一个 API Key 可在手机上查看并控制这台电脑的 miniQ。</p>
          </div>
          <label className="remote-access-toggle">
            <span><strong>允许远程连接</strong><small>daemon 主动连接 relay，无需暴露本机端口</small></span>
            <input type="checkbox" checked={remoteEnabled} disabled={loading || saving} onChange={(event) => setRemoteEnabled(event.target.checked)} />
          </label>
          {remoteEnabled && <>
            <label>
              设备名称
              <input
                value={deviceName}
                disabled={loading || saving}
                onChange={(event) => {
                  if (Array.from(event.target.value).length <= 80) setDeviceName(event.target.value);
                }}
              />
            </label>
            <label>
              Relay URL
              <input value={relayUrl} inputMode="url" spellCheck={false} disabled={loading || saving} onChange={(event) => setRelayUrl(event.target.value)} />
            </label>
            {remoteStatus && (
              <div className={`remote-access-summary ${remoteStatus.state === "connected" ? "connected" : ""}`}>
                {remoteStatus.state === "connected" ? <Wifi size={17} /> : <WifiOff size={17} />}
                <div>
                  <strong>{remoteStatusLabel(remoteStatus.state)}</strong>
                  <p>{remoteStatus.state === "connected" ? `${remoteStatus.mobileClients} 台移动设备已连接` : remoteStatus.lastError ?? "保存后 daemon 会自动建立连接"}</p>
                </div>
              </div>
            )}
          </>}
        </section>
        </>}
        {(loading || status) && (
          <div className="settings-status" role="status" aria-live="polite">
            {loading ? "正在读取模型设置..." : status}
          </div>
        )}
        <div className="approval-actions">
          {props.client.mode === "local" && <button type="submit" disabled={loading || saving || !baseUrl.trim() || !model.trim() || !relayUrl.trim() || !deviceName.trim()}>
            {saving ? "正在保存..." : "保存模型设置"}
          </button>}
          <button type="button" className="secondary" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </form>
    </div>
  );
}

function remoteStatusLabel(state: SettingsView["remoteStatus"]["state"]): string {
  switch (state) {
    case "connected": return "远程连接已就绪";
    case "connecting": return "正在连接 relay";
    case "reconnecting": return "正在恢复远程连接";
    case "waiting_for_key": return "等待 API Key";
    default: return "远程访问未启用";
  }
}
