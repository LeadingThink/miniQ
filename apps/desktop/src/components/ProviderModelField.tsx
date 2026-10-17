import { useEffect, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import { ModelRankingLink } from "./ModelRankingLink";

interface ProviderModelFieldProps {
  client: RpcClient;
  baseUrl: string;
  apiKey?: string;
  ready: boolean;
  disabled: boolean;
  value: string;
  onChange: (value: string) => void;
}

function useProviderModels({ client, baseUrl, apiKey, ready }: ProviderModelFieldProps) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setModels([]);
    setError(null);
    setLoading(ready && !!baseUrl);
    if (!ready || !baseUrl) return;
    // Wait for URL/key edits to settle; catalog loading never blocks editing or saving.
    const timer = window.setTimeout(() => {
      const params: { baseUrl: string; apiKey?: string } = { baseUrl };
      if (apiKey) params.apiKey = apiKey;
      void client.call<{ models: string[] }>("settings.models", params, { signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted) return;
          if (!Array.isArray(result.models) || result.models.some((model) => typeof model !== "string")) {
            throw new Error("模型列表格式无效");
          }
          setModels(result.models);
        })
        .catch((cause) => {
          if (!controller.signal.aborted) setError(`模型列表读取失败：${errorMessage(cause)}`);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [client, baseUrl, apiKey, ready, revision]);
  return { models, loading, error, refresh: () => setRevision((current) => current + 1) };
}

export function ProviderModelField(props: ProviderModelFieldProps) {
  const { models, loading, error, refresh } = useProviderModels(props);
  return (
    <div>
      <label htmlFor="provider-default-model">
        默认 Chat 模型
        <input
          id="provider-default-model"
          list="provider-model-options"
          value={props.value}
          disabled={props.disabled}
          spellCheck={false}
          autoComplete="off"
          placeholder="输入模型 ID 或从列表选择"
          onChange={(event) => props.onChange(event.target.value)}
        />
        <datalist id="provider-model-options">
          {models.map((model) => <option key={model} value={model} />)}
        </datalist>
        <small>作为所有项目和新会话的全局默认模型；项目或会话可单独覆盖。</small>
        <small>可直接输入服务商提供的模型 ID，或清空输入后从列表选择。</small>
        <ModelRankingLink />
      </label>
      <button type="button" className="secondary" disabled={props.disabled || !props.ready || !props.baseUrl || loading} onClick={refresh}>
        {loading ? "正在读取模型列表…" : "刷新模型列表"}
      </button>
      {error && <small role="status">{error}，可手动输入模型 ID 并保存。</small>}
      {props.ready && !loading && !error && models.length === 0 && (
        <small role="status">服务未返回可选模型，可手动输入模型 ID 并保存。</small>
      )}
    </div>
  );
}
