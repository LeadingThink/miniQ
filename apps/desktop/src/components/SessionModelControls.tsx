import { ModelRankingLink } from "./ModelRankingLink";
import SiClaude from "@icons-pack/react-simple-icons/icons/SiClaude";
import SiDeepseek from "@icons-pack/react-simple-icons/icons/SiDeepseek";
import SiGooglegemini from "@icons-pack/react-simple-icons/icons/SiGooglegemini";
import SiMeta from "@icons-pack/react-simple-icons/icons/SiMeta";
import SiMinimax from "@icons-pack/react-simple-icons/icons/SiMinimax";
import SiMistralai from "@icons-pack/react-simple-icons/icons/SiMistralai";
import SiMoonshotai from "@icons-pack/react-simple-icons/icons/SiMoonshotai";
import SiQwen from "@icons-pack/react-simple-icons/icons/SiQwen";
import SiX from "@icons-pack/react-simple-icons/icons/SiX";
import { Boxes, BrainCircuit, Check, ChevronDown, Cpu, RefreshCw, Search, Sparkles, Star, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  DEFAULT_MODEL_SETTINGS,
  DEFAULT_MODEL_ID,
  EFFORT_LABELS,
  filterModelIds,
  modelControlLabel,
  type ModelDescription,
  type ReasoningEffort,
} from "../modelSelection";
import type { RpcClient } from "../rpc";
import type { ModelPerformanceResult } from "../modelPerformance";
import type { useSessionModel } from "../hooks/useSessionModel";
import { ModelPerformanceIndicator } from "./ModelPerformanceIndicator";
import { SessionModelSurface } from "./SessionModelSurface";
import {
  groupModelIds,
  modelProvider,
  readFavoriteModelIds,
  writeFavoriteModelIds,
  type ModelPickerCategory,
  type ModelProvider,
} from "../modelPickerCatalog";

const MODEL_DIALOG_QUERY = "(max-width: 720px), (pointer: coarse)";
const SUBMENU_WIDTH = 164;
const SUBMENU_GAP = 6;

function needsModelDialog() {
  return window.matchMedia?.(MODEL_DIALOG_QUERY).matches ?? window.innerWidth <= 720;
}

function ProviderIcon({ provider }: { provider: ModelProvider }) {
  const brandProps = { size: 17, color: "default" as const, "aria-hidden": true };
  switch (provider) {
    case "anthropic": return <SiClaude {...brandProps} />;
    case "google": return <SiGooglegemini {...brandProps} />;
    case "deepseek": return <SiDeepseek {...brandProps} />;
    case "xai": return <SiX {...brandProps} />;
    case "alibaba": return <SiQwen {...brandProps} />;
    case "meta": return <SiMeta {...brandProps} />;
    case "mistral": return <SiMistralai {...brandProps} />;
    case "moonshot": return <SiMoonshotai {...brandProps} />;
    case "minimax": return <SiMinimax {...brandProps} />;
    case "zhipu": return <BrainCircuit size={17} aria-hidden="true" />;
    case "other": return <Boxes size={17} aria-hidden="true" />;
    default: return <Sparkles size={17} aria-hidden="true" />;
  }
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
  const [performance, setPerformance] = useState<ModelPerformanceResult | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ModelPickerCategory>("openai");
  const [favoriteModels, setFavoriteModels] = useState<string[]>(() => readFavoriteModelIds(window.localStorage));
  const [selectedModel, setSelectedModel] = useState("");
  const [hovered, setHovered] = useState("");
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [selectedEffort, setSelectedEffort] = useState<ReasoningEffort | null>(null);
  const [description, setDescription] = useState<ModelDescription | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [descriptionFor, setDescriptionFor] = useState("");
  const [descriptionLoading, setDescriptionLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hoveredRow = useRef<HTMLElement | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const descriptions = useRef(new Map<string, ModelDescription>());
  const [mobile, setMobile] = useState(needsModelDialog);
  const [popoverMaxHeight, setPopoverMaxHeight] = useState<number | null>(null);
  const disabled = busy || model.pending || !model.ready;

  const placeSubmenu = useCallback((row: HTMLElement) => {
    const rect = row.getBoundingClientRect();
    const height = submenuRef.current?.offsetHeight ?? 0;
    setMenuPos({
      top: Math.max(8, Math.min(rect.top, window.innerHeight - height - 8)),
      left: Math.max(8, Math.min(rect.right + SUBMENU_GAP, window.innerWidth - SUBMENU_WIDTH - 8)),
    });
  }, []);

  const cancelClose = useCallback(() => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  }, []);

  useEffect(() => cancelClose, [cancelClose]);

  const closeSubmenu = useCallback(() => {
    cancelClose();
    setHovered("");
    setMenuPos(null);
    hoveredRow.current = null;
  }, [cancelClose]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      setHovered("");
      setMenuPos(null);
      hoveredRow.current = null;
    }, 160);
  }, [cancelClose]);

  const openSubmenu = useCallback((id: string, row: HTMLElement | null) => {
    cancelClose();
    setHovered(id);
    hoveredRow.current = row;
    if (!mobile && row) placeSubmenu(row);
  }, [cancelClose, mobile, placeSubmenu]);

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
    if (!open) {
      closeSubmenu();
      return;
    }
    const handleOutsideMouseDown = (event: MouseEvent) => {
      const root = rootRef.current;
      const target = event.target as Node;
      if (root && !root.contains(target) && !panelRef.current?.contains(target) && !submenuRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", handleOutsideMouseDown);
    return () => document.removeEventListener("mousedown", handleOutsideMouseDown);
  }, [open, closeSubmenu]);

  // The portal uses viewport coordinates; measure again when reasoning levels load.
  useLayoutEffect(() => {
    if (!open || mobile || !hovered) return;
    const reposition = () => {
      if (hoveredRow.current) placeSubmenu(hoveredRow.current);
    };
    reposition();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reposition);
    if (submenuRef.current) observer?.observe(submenuRef.current);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, mobile, hovered, placeSubmenu]);

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
      setPopoverMaxHeight(Math.max(160, Math.floor(availableHeight)));
    };
    updatePopoverHeight();
    window.addEventListener("resize", updatePopoverHeight);
    return () => window.removeEventListener("resize", updatePopoverHeight);
  }, [open, placement, mobile]);

  useEffect(() => {
    setSelectedModel(model.settings.model ?? model.effective?.model ?? "");
    setSelectedEffort(model.settings.reasoningEffort ?? model.effective?.reasoningEffort ?? null);
  }, [model.settings.model, model.settings.reasoningEffort, model.effective?.model, model.effective?.reasoningEffort]);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setLoading(true);
    setCatalogError(null);
    setPerformance(null);
    void client
      .call<ModelPerformanceResult>("model.performance")
      .then((result) => {
        if (!stale) setPerformance(result);
      })
      .catch(() => {
        if (!stale) setPerformance(null);
      });
    void client
      .call<{ models: string[] }>("model.list")
      .then((result) => {
        if (stale) return;
        const nextModels = Array.isArray(result.models) ? result.models : [];
        setModels(nextModels);
        const currentProvider = modelProvider(model.settings.model ?? model.effective?.model ?? "");
        const groups = groupModelIds(nextModels);
        setCategory(groups.some((group) => group.category === currentProvider)
          ? currentProvider
          : (groups[0]?.category ?? "other"));
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
  }, [client, open, attempt, model.settings.model, model.effective?.model]);

  // 悬停的模型决定右侧档位菜单；描述按模型缓存，来回划过不发请求。
  const describeTarget = open ? hovered || selectedModel : (model.effective?.model ?? "");
  useEffect(() => {
    if (!describeTarget) return;
    const cached = descriptions.current.get(describeTarget);
    if (cached) {
      setDescription(cached);
      setDescriptionFor(describeTarget);
      setDescriptionError(null);
      setDescriptionLoading(false);
      return;
    }
    let stale = false;
    setDescriptionLoading(true);
    setDescriptionFor(describeTarget);
    setDescription(null);
    setDescriptionError(null);
    void client
      .call<ModelDescription>("model.describe", {
        model: describeTarget,
        apiProtocol: open ? "auto" : (model.effective?.apiProtocol ?? "auto"),
      })
      .then((value) => {
        descriptions.current.set(describeTarget, value);
        if (!stale) {
          setDescription(value);
          setDescriptionFor(describeTarget);
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
  }, [client, describeTarget, model.effective?.apiProtocol, open, attempt]);

  const applySelection = async (
    id: string | null,
    effort: ReasoningEffort | null,
  ) => {
    if (disabled || (id !== null && (loading || catalogError || !models.includes(id)))) return;
    try {
      await model.update({ ...model.settings, model: id, apiProtocol: "auto", reasoningEffort: effort });
      setSelectedModel(id ?? "");
      setSelectedEffort(effort);
      setQuery("");
      setOpen(false);
    } catch { /* The model hook exposes the save error. */ }
  };
  const restoreDefault = async () => {
    if (disabled) return;
    try {
      await model.update({
        ...DEFAULT_MODEL_SETTINGS,
        model: DEFAULT_MODEL_ID,
      });
      setSelectedModel(DEFAULT_MODEL_ID);
      setSelectedEffort(null);
      setQuery("");
      setOpen(false);
    } catch { /* The model hook exposes the save error. */ }
  };
  const currentModel = model.settings.model ?? model.effective?.model ?? "";
  const currentEffort = model.settings.reasoningEffort ?? model.effective?.reasoningEffort ?? null;
  const currentLabel = modelControlLabel(model.settings, model.effective);
  const displayModel = open ? selectedModel : currentLabel.model;
  const displayEffort = open
    ? selectedEffort
      ? EFFORT_LABELS[selectedEffort]
      : selectedModel === DEFAULT_MODEL_ID
        ? "默认"
        : null
    : currentLabel.effort;
  const visibleModels = filterModelIds(models, query);
  const groupedModels = groupModelIds(visibleModels);
  const providerGroups = groupModelIds(models);
  const displayedModels = query
    ? visibleModels
    : category === "favorites"
    ? visibleModels.filter((id) => favoriteModels.includes(id))
    : groupedModels.find((group) => group.category === category)?.models ?? [];
  const toggleFavorite = (id: string) => {
    const next = favoriteModels.includes(id)
      ? favoriteModels.filter((model) => model !== id)
      : [...favoriteModels, id];
    setFavoriteModels(next);
    writeFavoriteModelIds(window.localStorage, next);
  };
  const effortOptions = description?.reasoningEfforts ?? [];
  const selectEffort = (id: string, effort: ReasoningEffort | null) => {
    if (mobile) setSelectedEffort(effort);
    else void applySelection(id, effort);
  };

  const effortList = (id: string) => (
    <div className="model-picker-effort-options" role="group" aria-label="思考强度档位">
      <button
        type="button"
        aria-pressed={id !== selectedModel || selectedEffort === null}
        disabled={disabled}
        onClick={() => selectEffort(id, null)}
      >默认</button>
      {effortOptions.map((effort) => (
        <button
          key={effort}
          type="button"
          aria-pressed={id === selectedModel && selectedEffort === effort}
          disabled={disabled}
          onClick={() => selectEffort(id, effort)}
        >
          {EFFORT_LABELS[effort]}
          {id === selectedModel && selectedEffort === effort && <Check size={12} aria-hidden="true" />}
        </button>
      ))}
    </div>
  );

  const effortState = descriptionLoading || descriptionFor !== describeTarget
    ? <p className="model-picker-status" role="status">读取档位…</p>
    : descriptionError
      ? <div className="model-picker-status" role="alert">读取失败<button type="button" className="ghost" onClick={() => setAttempt((value) => value + 1)}>重试</button></div>
      : effortOptions.length
        ? effortList(hovered || selectedModel)
        : <p className="model-picker-status">该模型不支持调整</p>;

  const modelError = model.error && (
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
  );

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
        aria-haspopup="dialog"
        aria-label="选择模型和思考强度"
        title={busy ? "当前任务结束后可更换模型" : "选择模型和思考强度"}
        onClick={() => {
          const next = !open;
          setOpen(next);
          setQuery("");
          closeSubmenu();
          const startingModel = model.settings.model ?? model.effective?.model ?? "";
          setSelectedModel(startingModel);
          setSelectedEffort(model.settings.reasoningEffort ?? model.effective?.reasoningEffort ?? null);
        }}
      >
        <Cpu size={14} />
        <span className="model-trigger-name">{displayModel}</span>
        {displayEffort && (
          <>
            <span className="model-trigger-separator" aria-hidden="true">·</span>
            <span>{displayEffort}</span>
          </>
        )}
        <ChevronDown size={13} aria-hidden="true" />
      </button>
      {!open && modelError}
      {open && (
        <SessionModelSurface mobile={mobile} trigger={triggerRef} onClose={() => setOpen(false)}>
          <div
            ref={panelRef}
            className="session-model-popover"
            style={popoverMaxHeight === null ? undefined : { maxHeight: `${popoverMaxHeight}px` }}
            role={mobile ? undefined : "dialog"}
            aria-label={mobile ? undefined : "选择会话模型"}
            aria-busy={model.pending}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (hovered) closeSubmenu();
                else setOpen(false);
              }
            }}
            onMouseLeave={mobile ? undefined : scheduleClose}
          >
            <header>
              <strong>选择模型</strong>
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
            <div className="model-picker-search">
              <Search size={14} aria-hidden="true" />
              <input
                autoFocus={!mobile}
                value={query}
                placeholder="搜索模型"
                aria-label="模型 ID"
                disabled={disabled}
                spellCheck={false}
                onChange={(event) => { setQuery(event.target.value); closeSubmenu(); }}
              />
            </div>
            {!mobile && (
              <div className="model-picker-body">
                <nav className="model-picker-nav" aria-label="模型分类">
                  <button type="button" className={category === "favorites" && !query ? "active" : undefined} aria-label="收藏" title="收藏" aria-pressed={category === "favorites" && !query} onClick={() => { setQuery(""); setCategory("favorites"); }}>
                    <Star size={15} aria-hidden="true" />
                    <span>收藏</span>
                  </button>
                  <div className="model-picker-nav-divider" aria-hidden="true" />
                  {providerGroups.map((group) => (
                    <button
                      type="button"
                      key={group.category}
                      className={category === group.category && !query ? "active" : undefined}
                      aria-label={group.label}
                      title={group.label}
                      aria-pressed={category === group.category && !query}
                      onClick={() => { setQuery(""); setCategory(group.category); }}
                    >
                      <ProviderIcon provider={group.category as ModelProvider} />
                      <span>{group.label}</span>
                    </button>
                  ))}
                </nav>
                <div className="model-picker-results">
                  <div className="model-picker-group-title">
                    {query ? "搜索结果" : category === "favorites" ? "收藏" : providerGroups.find((group) => group.category === category)?.label ?? "模型"}
                  </div>
                {loading && <span role="status" className="model-picker-status">正在读取模型列表</span>}
                {catalogError && (
                  <div role="alert" className="model-picker-status">
                    {catalogError}
                    <button className="icon-button" type="button" aria-label="重试模型列表" title="重试模型列表" onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={14} /></button>
                  </div>
                )}
                {!query && category === "favorites" && !loading && !catalogError && displayedModels.length === 0 && <span className="model-picker-status">还没有收藏模型</span>}
                {(query || category !== "favorites") && !loading && !catalogError && displayedModels.length === 0 && <span className="model-picker-status">没有匹配的文本模型</span>}
                <div className="model-picker-list" role="listbox" aria-label="会话模型列表">
                  {displayedModels.map((id) => {
                    const selected = id === selectedModel;
                    return (
                      <div className="model-picker-row" key={id}>
                        <button type="button" role="option" aria-label={id} aria-selected={selected} aria-haspopup="menu" disabled={disabled} title={id} className={id === hovered ? "active" : undefined} onMouseEnter={(event) => openSubmenu(id, event.currentTarget)} onFocus={(event) => openSubmenu(id, event.currentTarget)} onClick={() => { closeSubmenu(); const effort = id === currentModel ? currentEffort : null; void applySelection(id, effort); }}>
                          <span className="model-picker-name">{id}</span>
                          <ModelPerformanceIndicator modelId={id} metric={performance?.models?.[id]} windowHours={performance?.windowHours ?? null} />
                          {selected && <Check size={13} aria-hidden="true" />}
                        </button>
                        <button
                          type="button"
                          className="model-picker-favorite"
                          aria-label={favoriteModels.includes(id) ? `取消收藏 ${id}` : `收藏 ${id}`}
                          aria-pressed={favoriteModels.includes(id)}
                          title={favoriteModels.includes(id) ? "取消收藏" : "收藏模型"}
                          onClick={(event) => { event.stopPropagation(); toggleFavorite(id); }}
                        >
                          <Star size={15} fill={favoriteModels.includes(id) ? "currentColor" : "none"} aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })}
                </div>
                </div>
              </div>
            )}
            {mobile && loading && <span role="status" className="model-picker-status">正在读取模型列表</span>}
            {mobile && catalogError && (
              <div role="alert" className="model-picker-status">
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
            {mobile && <div className="model-picker-list" role="listbox" aria-label="会话模型列表">
              {visibleModels.map((id) => {
                const selected = id === selectedModel;
                return (
                  <div className="model-picker-row" key={id}>
                    <button
                      type="button"
                      role="option"
                      aria-label={id}
                      aria-selected={selected}
                      aria-haspopup="menu"
                      disabled={disabled}
                      title={id}
                      className={id === hovered ? "active" : undefined}
                      onMouseEnter={mobile ? undefined : (event) => openSubmenu(id, event.currentTarget)}
                      onFocus={mobile ? undefined : (event) => openSubmenu(id, event.currentTarget)}
                      onClick={() => {
                        closeSubmenu();
                        // 同一模型再点一次时保留已选档位，换模型才回到默认。
                        const effort = id === currentModel ? currentEffort : null;
                        if (mobile) {
                          // Existing sessions broadcast changes on save; defer it until Done.
                          setSelectedEffort(id === selectedModel ? selectedEffort : effort);
                          setSelectedModel(id);
                          openSubmenu(id, null);
                        } else {
                          void applySelection(id, effort);
                        }
                      }}
                    >
                      <span className="model-picker-name">{id}</span>
                      <ModelPerformanceIndicator modelId={id} metric={performance?.models?.[id]} windowHours={performance?.windowHours ?? null} />
                      {selected && <Check size={13} aria-hidden="true" />}
                    </button>
                    {mobile && hovered === id && (
                      <div className="model-picker-inline-effort" aria-label="思考强度">
                        <span className="model-picker-effort-title">思考强度</span>
                        {effortState}
                      </div>
                    )}
                  </div>
                );
              })}
              {visibleModels.length === 0 && !loading && (
                <span className="model-picker-status">没有匹配的文本模型</span>
              )}
            </div>}
            {modelError}
            <footer>
              <button
                type="button"
                className="ghost"
                disabled={disabled}
                onClick={() => void restoreDefault()}
              >
                <RefreshCw size={14} />
                恢复默认
              </button>
              <ModelRankingLink />
              {mobile && (
                <button type="button" disabled={disabled || loading || !!catalogError || !models.includes(selectedModel)}
                  onClick={() => void applySelection(selectedModel, selectedEffort)}>
                  <Check size={14} />
                  完成
                </button>
              )}
            </footer>
          </div>
        </SessionModelSurface>
      )}
      {open && !mobile && hovered && menuPos && createPortal(
        <div
          ref={submenuRef}
          className="model-picker-submenu"
          role="group"
          aria-label="思考强度"
          style={{ top: menuPos.top, left: menuPos.left }}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeSubmenu();
              panelRef.current?.querySelector("input")?.focus();
            }
          }}
        >
          <div className="model-picker-submenu-title">思考强度</div>
          {effortState}
        </div>, document.body
      )}
    </div>
  );
}
