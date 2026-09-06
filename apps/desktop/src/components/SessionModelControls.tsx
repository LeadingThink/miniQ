import { Check, Cpu, RefreshCw, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  EFFORT_LABELS,
  PROTOCOL_LABELS,
  DEFAULT_MODEL_SETTINGS,
  filterModelIds,
  type ApiProtocol,
  type ModelDescription,
  type ReasoningEffort,
} from "../modelSelection";
import type { RpcClient } from "../rpc";
import type { useSessionModel } from "../hooks/useSessionModel";

export function SessionModelControls({
  client,
  model,
  busy,
}: {
  client: RpcClient;
  model: ReturnType<typeof useSessionModel>;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [protocol, setProtocol] = useState<ApiProtocol>("auto");
  const [description, setDescription] = useState<ModelDescription | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const listId = useId();
  const disabled = busy || model.pending || !model.ready;

  useEffect(() => {
    if (!model.effective) return;
    let stale = false;
    setDescription(null);
    setDescriptionError(null);
    void client
      .call<ModelDescription>("model.describe", {
        model: model.effective.model,
        apiProtocol: model.effective.apiProtocol,
      })
      .then((value) => {
        if (!stale) setDescription(value);
      })
      .catch((cause) => {
        if (!stale) setDescriptionError(String(cause));
      });
    return () => {
      stale = true;
    };
  }, [client, model.effective?.model, model.effective?.apiProtocol, attempt]);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setLoading(true);
    setCatalogError(null);
    void client
      .call<{ models: string[] }>("model.list")
      .then((result) => {
        if (!stale) setModels(result.models);
      })
      .catch((cause) => {
        if (!stale) setCatalogError(String(cause));
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [client, open, attempt]);

  return (
    <div className="session-model-controls">
      <button
        type="button"
        className="model-trigger"
        disabled={disabled}
        aria-expanded={open}
        aria-label="选择会话模型"
        title={
          busy
            ? "当前任务结束后可更换模型"
            : model.effective?.model ?? "选择模型"
        }
        onClick={() => {
          setOpen(!open);
          setQuery(model.settings.model ?? "");
          setProtocol(model.settings.apiProtocol);
        }}
      >
        <Cpu size={14} />
        <span>{model.effective?.model ?? "模型"}</span>
      </button>
      <select
        aria-label="会话推理强度"
        title={
          description?.reasoningEfforts.length
            ? "推理强度"
            : "使用模型默认推理设置"
        }
        disabled={disabled || !description?.reasoningEfforts.length}
        value={model.settings.reasoningEffort ?? ""}
        onChange={(event) =>
          void model
            .update({
              ...model.settings,
              reasoningEffort: (event.target.value as ReasoningEffort) || null,
            })
            .catch(() => {})
        }
      >
        <option value="">默认推理</option>
        {description?.reasoningEfforts.map((effort) => (
          <option key={effort} value={effort}>
            {EFFORT_LABELS[effort]}
          </option>
        ))}
      </select>
      {model.error && (
        <span role="alert" className="model-error">
          {model.error}
          <button
            type="button"
            className="icon-button"
            aria-label="重新读取模型配置"
            title="重新读取模型配置"
            onClick={() => void model.reload()}
          >
            <RefreshCw size={14} />
          </button>
        </span>
      )}
      {open && (
        <form
          className="session-model-popover"
          aria-label="会话模型配置"
          onSubmit={(event) => {
            event.preventDefault();
            void model
              .update({
                model: query.trim() || null,
                apiProtocol: protocol,
                reasoningEffort: null,
              })
              .then(() => setOpen(false))
              .catch(() => {});
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <header>
            <strong>会话模型</strong>
            <button
              type="button"
              className="icon-button"
              aria-label="关闭模型选择"
              title="关闭模型选择"
              onClick={() => setOpen(false)}
            >
              <X size={15} />
            </button>
          </header>
          <label>
            模型 ID
            <input
              autoFocus
              list={listId}
              value={query}
              placeholder={model.effective?.model ?? "模型 ID"}
              onChange={(event) => setQuery(event.target.value)}
              spellCheck={false}
            />
          </label>
          <datalist id={listId}>
            {filterModelIds(models, query).map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
          <label>
            API 协议
            <select
              value={protocol}
              onChange={(event) =>
                setProtocol(event.target.value as ApiProtocol)
              }
            >
              {Object.entries(PROTOCOL_LABELS).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {loading && <span role="status">正在读取模型列表</span>}
          {catalogError && (
            <div role="alert">
              {catalogError}
              <button
                className="icon-button"
                type="button"
                aria-label="重试模型列表"
                title="重试模型列表"
                onClick={() => setAttempt((value) => value + 1)}
              >
                <RefreshCw size={14} />
              </button>
            </div>
          )}
          {description && (
            <dl className="model-capabilities">
              <dt>当前协议</dt>
              <dd>{PROTOCOL_LABELS[description.apiProtocol]}</dd>
              <dt>上下文上限</dt>
              <dd>
                {description.maxContextTokens?.toLocaleString() ?? "未提供"}
              </dd>
              <dt>输出上限</dt>
              <dd>
                {description.maxOutputTokens?.toLocaleString() ?? "未提供"}
              </dd>
            </dl>
          )}
          {descriptionError && <span role="alert">{descriptionError}</span>}
          <footer>
            <button
              type="button"
              className="ghost"
              disabled={disabled}
              onClick={() =>
                void model
                  .update(DEFAULT_MODEL_SETTINGS)
                  .then(() => setOpen(false))
                  .catch(() => {})
              }
            >
              <RefreshCw size={14} />
              恢复默认
            </button>
            <button type="submit" disabled={disabled}>
              <Check size={14} />
              应用
            </button>
          </footer>
        </form>
      )}
    </div>
  );
}
