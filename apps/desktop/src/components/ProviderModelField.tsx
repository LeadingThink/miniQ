import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";

export function ProviderModelField({
  client,
  baseUrl,
  apiKey,
  model,
  disabled,
  onChange,
  onStatus,
}: {
  client: RpcClient;
  baseUrl: string;
  apiKey: string;
  model: string;
  disabled: boolean;
  onChange: (model: string) => void;
  onStatus: (status: string | null) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setModels([]);
    setMenuOpen(false);
    setLoading(false);
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [client, baseUrl, apiKey]);
  const load = async () => {
    if (request.current || disabled || !baseUrl.trim()) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    onStatus(null);
    const params: { baseUrl: string; apiKey?: string } = {
      baseUrl: baseUrl.trim(),
    };
    if (apiKey.trim()) params.apiKey = apiKey.trim();
    try {
      const result = await client.call<{ models: string[] }>(
        "settings.models",
        params,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setModels(result.models);
      onStatus(
        result.models.length
          ? `已获取 ${result.models.length} 个模型`
          : "供应商未返回可用模型",
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      setModels([]);
      onStatus(`获取模型列表失败：${errorMessage(error)}`);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  };
  return (
    <span className="provider-model-control">
      {models.length > 0 ? (
        <span className="provider-model-select">
          <button
            type="button"
            className="provider-model-select-trigger"
            aria-label="Model"
            aria-haspopup="listbox"
            aria-expanded={menuOpen}
            disabled={disabled || loading}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span>{model}</span>
            <ChevronDown size={15} />
          </button>
          {menuOpen && (
            <span className="provider-model-menu" role="listbox" aria-label="模型列表">
              {model && !models.includes(model) && (
                <button type="button" role="option" aria-selected onClick={() => setMenuOpen(false)}>
                  <span>{model}</span>
                  <Check size={14} />
                </button>
              )}
              {models.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="option"
                  aria-selected={value === model}
                  onClick={() => {
                    onChange(value);
                    setMenuOpen(false);
                  }}
                >
                  <span>{value}</span>
                  {value === model && <Check size={14} />}
                </button>
              ))}
            </span>
          )}
        </span>
      ) : (
        <input
          aria-label="Model"
          value={model}
          disabled={disabled || loading}
          spellCheck={false}
          placeholder="gpt-4o-mini"
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <button
        type="button"
        className="provider-model-list-button"
        aria-label="获取模型列表"
        aria-busy={loading}
        disabled={disabled || loading || !baseUrl.trim()}
        onClick={() => void load()}
      >
        <span>{loading ? "正在获取" : "获取模型列表"}</span>
      </button>
    </span>
  );
}
