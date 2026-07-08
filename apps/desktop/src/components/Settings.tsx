import { useEffect, useState } from "react";
import type { RpcClient } from "../rpc";

interface ProviderView {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
}

interface SettingsView {
  provider: ProviderView | null;
}

export function SettingsPanel(props: { client: RpcClient; onClose: () => void }) {
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
      setStatus("Saved.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="settings-overlay" onClick={props.onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()}>
        <h2>Model provider (OpenAI-compatible)</h2>
        <label>
          Base URL
          <input
            value={baseUrl}
            placeholder="https://api.openai.com/v1"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        <label>
          Model
          <input
            value={model}
            placeholder="gpt-4o-mini"
            onChange={(e) => setModel(e.target.value)}
          />
        </label>
        <label>
          API key {hasKey && <span className="badge">stored</span>}
          <input
            type="password"
            value={apiKey}
            placeholder={hasKey ? "leave empty to keep the stored key" : "sk-..."}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </label>
        {status && <div className="settings-status">{status}</div>}
        <div className="approval-actions">
          <button onClick={save} disabled={!baseUrl.trim() || !model.trim()}>
            Save
          </button>
          <button className="secondary" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
