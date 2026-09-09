import { RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
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
  const listId = useId();
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    setModels([]);
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
      <input
        aria-label="Model"
        list={models.length ? listId : undefined}
        value={model}
        disabled={disabled}
        spellCheck={false}
        placeholder="gpt-4o-mini"
        onChange={(event) => onChange(event.target.value)}
      />
      <datalist id={listId}>
        {models.map((value) => (
          <option key={value} value={value} />
        ))}
      </datalist>
      <button
        type="button"
        className="icon-button provider-model-list-button"
        title="获取模型列表"
        aria-label="获取模型列表"
        aria-busy={loading}
        disabled={disabled || loading || !baseUrl.trim()}
        onClick={() => void load()}
      >
        <RefreshCw size={16} />
      </button>
    </span>
  );
}
