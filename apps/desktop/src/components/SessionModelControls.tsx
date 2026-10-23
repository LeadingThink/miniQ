import { ModelRankingLink } from "./ModelRankingLink";
import { Check, ChevronDown, Cpu, RefreshCw, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  DEFAULT_MODEL_SETTINGS,
  EFFORT_LABELS,
  filterModelIds,
  type ModelDescription,
  type ReasoningEffort,
} from "../modelSelection";
import type { RpcClient } from "../rpc";
import type { useSessionModel } from "../hooks/useSessionModel";
import { SessionModelSurface } from "./SessionModelSurface";

const MODEL_DIALOG_QUERY = "(max-width: 720px), (pointer: coarse)";
function needsModelDialog() {
  return window.matchMedia?.(MODEL_DIALOG_QUERY).matches ?? window.innerWidth <= 720;
}

export function SessionModelControls({
  client,
  model,
  busy,
  placement = "above",
}: {
  client: RpcClient;
  model: ReturnType<typeof useSessionModel>;
  busy: boolean;
  placement?: "above" | "below";
}) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedEffort, setSelectedEffort] = useState<ReasoningEffort | null>(null);
  const [description, setDescription] = useState<ModelDescription | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [descriptionFor, setDescriptionFor] = useState("");
  const [descriptionLoading, setDescriptionLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [modelListOpen, setModelListOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [mobile, setMobile] = useState(needsModelDialog);
  const selectedModelRef = useRef<HTMLButtonElement>(null);
  const [popoverMaxHeight, setPopoverMaxHeight] = useState<number | null>(null);
  const disabled = busy || model.pending || !model.ready;

  useEffect(() => {
    const media = window.matchMedia?.(MODEL_DIALOG_QUERY);
    const update = () => setMobile(needsModelDialog());
    media?.addEventListener("change", update);
    return () => media?.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (busy || !model.ready) setOpen(false);
  }, [busy, model.ready]);

  useEffect(() => {
    if (!open) return;
    const handleOutsideMouseDown = (event: MouseEvent) => {
      const root = rootRef.current;
      if (root && !root.contains(event.target as Node) && !formRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handleOutsideMouseDown);
    return () => document.removeEventListener("mousedown", handleOutsideMouseDown);
  }, [open]);

  useLayoutEffect(() => {
    if (!open || mobile) {
      setPopoverMaxHeight(null);
      return;
    }
    const updatePopoverHeight = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const bounds = trigger.getBoundingClientRect();
      const availableHeight = placement === "below"
        ? window.innerHeight - bounds.bottom - 26
        : bounds.top - 26;
      setPopoverMaxHeight(Math.max(120, Math.floor(availableHeight)));
    };
    updatePopoverHeight();
    window.addEventListener("resize", updatePopoverHeight);
    return () => window.removeEventListener("resize", updatePopoverHeight);
  }, [open, placement, mobile]);

  const descriptionTarget = open ? selectedModel : model.effective?.model;
  useEffect(() => {
    if (!descriptionTarget || (!open && descriptionFor === descriptionTarget)) return;
    let stale = false;
    setDescriptionLoading(true);
    setDescription(null);
    setDescriptionError(null);
    void client
      .call<ModelDescription>("model.describe", {
        model: descriptionTarget,
        apiProtocol: open ? "auto" : (model.effective?.apiProtocol ?? "auto"),
      })
      .then((value) => {
        if (!stale) {
          setDescription(value);
          setDescriptionFor(descriptionTarget);
        }
      })
      .catch((cause) => {
        if (!stale) setDescriptionError(String(cause));
      })
      .finally(() => {
        if (!stale) setDescriptionLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [client, descriptionTarget, model.effective?.apiProtocol, open, attempt]);

  useEffect(() => {
    setSelectedModel(model.settings.model ?? model.effective?.model ?? "");
    setSelectedEffort(model.settings.reasoningEffort ?? model.effective?.reasoningEffort ?? null);
  }, [model.settings.model, model.settings.reasoningEffort, model.effective?.model, model.effective?.reasoningEffort]);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setLoading(true);
    setCatalogError(null);
    void client
      .call<{ models: string[] }>("model.list")
      .then((result) => {
        if (!stale) setModels(Array.isArray(result.models) ? result.models : []);
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

  useLayoutEffect(() => {
    if (!modelListOpen) return;
    const selectedModel = selectedModelRef.current;
    if (typeof selectedModel?.scrollIntoView === "function") {
      selectedModel.scrollIntoView({ block: "start" });
    }
  }, [modelListOpen, models, query]);

  const applySelection = async (
    id: string | null,
    effort: ReasoningEffort | null,
    closeAfterSave = mobile,
  ) => {
    if (disabled || (id !== null && (loading || catalogError || !models.includes(id)))) return;
    try {
      await model.update({ ...model.settings, model: id, apiProtocol: "auto", reasoningEffort: effort });
      setSelectedModel(id ?? "");
      setSelectedEffort(effort);
      setQuery("");
      setModelListOpen(false);
      if (closeAfterSave) setOpen(false);
    } catch { /* The model hook exposes the save error. */ }
  };
  const reopenList = () => {
    if (!modelListOpen) setQuery("");
    setModelListOpen(true);
  };
  const displayModel = open ? selectedModel : (model.effective?.model ?? "模型");

  return (
    <div
      ref={rootRef}
      className={`session-model-controls ${placement === "below" ? "popover-below" : ""}`}
    >
      <button
        type="button"
        className="model-trigger"
        ref={triggerRef}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup={mobile ? "dialog" : undefined}
        aria-label="选择模型和思考强度"
        title={busy ? "当前任务结束后可更换模型" : "选择模型和思考强度"}
        onClick={() => {
          setOpen(!open);
          setModelListOpen(mobile);
          setQuery("");
          setSelectedModel(model.settings.model ?? model.effective?.model ?? "");
          setSelectedEffort(model.settings.reasoningEffort ?? model.effective?.reasoningEffort ?? null);
        }}
      >
        <Cpu size={14} />
        <span>{displayModel}</span>
        <span className="model-trigger-separator" aria-hidden="true">·</span>
        <span>{model.settings.reasoningEffort
          ? EFFORT_LABELS[model.settings.reasoningEffort]
          : model.effective?.reasoningEffort
            ? EFFORT_LABELS[model.effective.reasoningEffort]
            : "默认"}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>
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
        <SessionModelSurface mobile={mobile} trigger={triggerRef} onClose={() => setOpen(false)}>
        <form
          ref={formRef}
          className="session-model-popover"
          style={
            popoverMaxHeight === null
              ? undefined
              : { maxHeight: `${popoverMaxHeight}px` }
          }
          aria-label="会话模型配置"
          aria-busy={model.pending}
          onSubmit={(event) => {
            event.preventDefault();
            void applySelection(selectedModel || null, selectedEffort, true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
              event.preventDefault();
              if (!event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) reopenList();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              if (modelListOpen) setModelListOpen(false);
              else setOpen(false);
            }
          }}
        >
          <header>
            <div>
              <strong>会话模型</strong>
              <ModelRankingLink />
            </div>
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
            {models.length > 0 ? (
              <span className="session-model-select">
                <span className="session-model-search">
                  <input
                    autoFocus={!mobile}
                    enterKeyHint={mobile ? "search" : undefined}
                    value={query}
                    placeholder={selectedModel || "搜索模型"}
                    aria-label="模型 ID"
                    disabled={disabled}
                    onFocus={reopenList}
                    onClick={reopenList}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setModelListOpen(true);
                    }}
                    spellCheck={false}
                  />
                  <ChevronDown size={15} />
                </span>
                {modelListOpen && (
                  <span
                    className="session-model-list"
                    role="listbox"
                    aria-label="会话模型列表"
                  >
                    {filterModelIds(models, query).map((id) => {
                      const selected = id === selectedModel;
                      return (
                        <button
                          key={id}
                          ref={selected ? selectedModelRef : undefined}
                          type="button"
                          role="option"
                          aria-selected={selected}
                          disabled={disabled}
                          onClick={() => {
                            setSelectedModel(id);
                            setSelectedEffort(null);
                            setQuery("");
                            setModelListOpen(false);
                          }}
                        >
                          <span>{id}</span>
                          {selected && <Check size={14} />}
                        </button>
                      );
                    })}
                    {filterModelIds(models, query).length === 0 && (
                      <span className="session-model-empty">没有匹配的文本模型</span>
                    )}
                  </span>
                )}
              </span>
            ) : (
              <input
                autoFocus={!mobile}
                aria-label="模型 ID"
                disabled
                enterKeyHint={mobile ? "search" : undefined}
                value={query}
                placeholder={model.effective?.model ?? "模型 ID"}
                onChange={(event) => setQuery(event.target.value)}
                spellCheck={false}
              />
            )}
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
          <section className="session-model-effort" aria-label="思考强度">
            <div className="session-model-effort-heading">
              <strong>思考强度</strong>
              <span>{selectedEffort ? EFFORT_LABELS[selectedEffort] : "默认"}</span>
            </div>
            {descriptionLoading || descriptionFor !== descriptionTarget ? (
              <p className="session-model-effort-status" role="status">正在读取当前模型的思考档位…</p>
            ) : descriptionError ? (
              <div className="session-model-effort-status" role="alert">
                未能读取思考档位
                <button type="button" className="ghost" onClick={() => setAttempt((value) => value + 1)}>重试</button>
              </div>
            ) : description?.reasoningEfforts.length ? (
              <div className="session-model-effort-options" role="group" aria-label="思考强度档位">
                <button
                  type="button"
                  className="session-model-effort-option"
                  aria-pressed={selectedEffort === null}
                  onClick={() => setSelectedEffort(null)}
                >默认</button>
                {description.reasoningEfforts.map((effort) => (
                  <button
                    key={effort}
                    type="button"
                    className="session-model-effort-option"
                    aria-pressed={selectedEffort === effort}
                    onClick={() => setSelectedEffort(effort)}
                  >
                    {EFFORT_LABELS[effort]}
                  </button>
                ))}
              </div>
            ) : (
              <p className="session-model-effort-status" role="status">当前模型使用默认思考强度</p>
            )}
          </section>
          <footer>
            <button
              type="button"
              className="ghost"
              disabled={disabled}
              onClick={() => void applySelection(DEFAULT_MODEL_SETTINGS.model, null, true)}
            >
              <RefreshCw size={14} />
              恢复默认
            </button>
            <button type="submit" disabled={disabled || loading || Boolean(catalogError) || !models.includes(selectedModel)}>
              <Check size={14} />
              {model.pending ? "正在应用…" : "应用"}
            </button>
          </footer>
        </form>
        </SessionModelSurface>
      )}
    </div>
  );
}
