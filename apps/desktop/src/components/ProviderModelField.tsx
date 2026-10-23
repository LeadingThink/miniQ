import { ChevronDown } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import { moveMenuIndex } from "../menuNavigation";
import { MODEL_AVAILABILITY_NOTICE, MODEL_AVAILABILITY_URL } from "../modelSelection";
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => {
    setOpen(false);
    setFiltering(false);
  }, [props.baseUrl, props.apiKey]);
  const catalogStatus = error
    ? `${error}，可手动输入模型 ID 并保存。`
    : props.ready && !loading && !error && models.length === 0
      ? "服务未返回可选模型，可手动输入模型 ID 并保存。"
      : null;
  const matches = useMemo(() => {
    const needle = filtering ? query.trim().toLowerCase() : "";
    if (!needle) return models;
    return models.filter((model) => model.toLowerCase().includes(needle));
  }, [filtering, models, query]);

  const showAll = () => {
    setFiltering(false);
    setQuery(props.value);
    setActiveIndex(Math.max(0, models.indexOf(props.value)));
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const choose = (model: string) => {
    props.onChange(model);
    setFiltering(false);
    setQuery(model);
    setOpen(false);
  };

  return (
    <div className="provider-model" ref={rootRef}>
      <label htmlFor="provider-default-model">
        默认 Chat 模型
        <span className="provider-model-input">
          <input
            id="provider-default-model"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            value={open ? query : props.value}
            disabled={props.disabled}
            spellCheck={false}
            autoComplete="off"
            placeholder="输入模型 ID 或从列表选择"
            onFocus={showAll}
            onChange={(event) => {
              setFiltering(true);
              setQuery(event.target.value);
              setActiveIndex(0);
              setOpen(true);
              props.onChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setOpen(true);
                setActiveIndex((current) => moveMenuIndex(current, matches.length, event.key === "ArrowDown" ? 1 : -1));
              } else if (event.key === "Enter" && open && matches[activeIndex]) {
                event.preventDefault();
                choose(matches[activeIndex]);
              } else if (event.key === "Escape") {
                setFiltering(false);
                setOpen(false);
              }
            }}
            onBlur={() => {
              setFiltering(false);
              window.setTimeout(() => setOpen(false), 120);
            }}
          />
          <button
            type="button"
            className="provider-model-toggle"
            aria-label={open ? "收起模型列表" : "展开模型列表"}
            disabled={props.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (open) setOpen(false);
              else showAll();
            }}
          >
            <ChevronDown size={16} />
          </button>
        </span>
      </label>
      {open && (
        <div className="provider-model-menu" id={listId} role="listbox" aria-label="可选模型">
          {matches.length === 0 ? (
            <div className="provider-model-empty">{loading ? "正在读取模型列表…" : "没有匹配的模型，可直接使用输入的 ID"}</div>
          ) : matches.map((model, index) => (
            <button
              type="button"
              role="option"
              aria-selected={model === props.value}
              className={index === activeIndex ? "active" : ""}
              key={model}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(model)}
            >
              {model}
            </button>
          ))}
        </div>
      )}
      <p>用于所有项目和新会话。项目或会话可以单独更换。可输入模型 ID，或从列表选择。</p>
      <div className="provider-model-actions">
        <button type="button" className="secondary" disabled={props.disabled || !props.ready || !props.baseUrl || loading} onClick={refresh}>
          {loading ? "正在读取模型列表…" : "刷新模型列表"}
        </button>
        <ModelRankingLink />
        <ModelRankingLink
          href={MODEL_AVAILABILITY_URL}
          label="查看模型可用性"
          notice={MODEL_AVAILABILITY_NOTICE}
          failure="无法打开模型可用性页面，请重试"
        />
      </div>
      {catalogStatus && <small role="status">{catalogStatus}</small>}
    </div>
  );
}
