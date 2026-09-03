import { Check, ExternalLink, KeyRound, Palette, Server, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import { openExternalUrl } from "../externalLinks";
import type { RpcClient } from "../rpc";
import { THEMES, type ThemeId } from "../theme";

export const ZAIWEN_API_PORTAL_URL = "https://platform.zaiwenai.com/";
export const ZAIWEN_API_BASE_URL = "https://oneapi.zaiwenai.com/v1";

interface ProviderView {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

interface SettingsView {
  provider: ProviderView | null;
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
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const panelRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    props.client
      .call<SettingsView>("settings.get")
      .then((res) => {
        if (res.provider) {
          setBaseUrl(res.provider.baseUrl);
          setModel(res.provider.model);
          setHasKey(res.provider.hasApiKey);
        }
        setStatus(null);
      })
      .catch((error) => setStatus(`读取设置失败：${errorMessage(error)}`))
      .finally(() => setLoading(false));
  }, [props.client]);

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
        };
        if (apiKey) provider.apiKey = apiKey;
        params.provider = provider;
      }
      const res = await props.client.call<SettingsView>("settings.update", params);
      setHasKey(res.provider?.hasApiKey ?? false);
      setApiKey("");
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

        <section className="settings-section provider-settings">
          <div>
            <div className="settings-section-title">模型服务</div>
            <p className="settings-section-description">兼容 OpenAI API 的服务地址</p>
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
                  setStatus("已填入在问 API 地址，请继续填写模型名称和 API Key");
                }}
              >
                <Server size={13} />
                填入接口地址
              </button>
            </div>
          </div>
        </section>
        {(loading || status) && (
          <div className="settings-status" role="status" aria-live="polite">
            {loading ? "正在读取模型设置..." : status}
          </div>
        )}
        <div className="approval-actions">
          <button type="submit" disabled={loading || saving || !baseUrl.trim() || !model.trim()}>
            {saving ? "正在保存..." : "保存模型设置"}
          </button>
          <button type="button" className="secondary" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </form>
    </div>
  );
}
