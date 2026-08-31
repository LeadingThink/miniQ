import { Check, Palette, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { RpcClient } from "../rpc";
import { THEMES, type ThemeId } from "../theme";

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

  useEffect(() => {
    props.client
      .call<SettingsView>("settings.get")
      .then((res) => {
        if (res.provider) {
          setBaseUrl(res.provider.baseUrl);
          setModel(res.provider.model);
          setHasKey(res.provider.hasApiKey);
        }
      })
      .catch((e) => setStatus(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setStatus(null);
    try {
      const params: Record<string, unknown> = {};
      if (baseUrl.trim() && model.trim()) {
        const provider: Record<string, unknown> = { baseUrl, model };
        if (apiKey) provider.apiKey = apiKey;
        params.provider = provider;
      }
      const res = await props.client.call<SettingsView>("settings.update", params);
      setHasKey(res.provider?.hasApiKey ?? false);
      setApiKey("");
      setStatus("已保存");
      setTimeout(() => props.onClose(), 500);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="settings-overlay" onClick={props.onClose}>
      <div className="settings-panel" onClick={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <div>
            <h2>设置</h2>
            <p>调整 miniQ 的外观和模型服务</p>
          </div>
          <button className="icon-button" title="关闭设置" onClick={props.onClose}>
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
              placeholder="https://api.openai.com/v1"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </label>
          <label>
            Model
            <input
              value={model}
              placeholder="gpt-4o-mini"
              onChange={(event) => setModel(event.target.value)}
            />
          </label>
          <label>
            API key {hasKey && <span className="badge">已保存</span>}
            <input
              type="password"
              value={apiKey}
              placeholder={hasKey ? "留空以保留当前密钥" : "sk-..."}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </label>
        </section>
        {status && <div className="settings-status">{status}</div>}
        <div className="approval-actions">
          <button onClick={save} disabled={!baseUrl.trim() || !model.trim()}>
            保存模型设置
          </button>
          <button className="secondary" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
