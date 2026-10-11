import { useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { filterModelIds } from "../modelSelection";
import { Popover } from "./ui/Popover";

/** Coarse model family, used only to hint that a reviewer may share blind spots. */
export function family(model: string) {
  return model.toLowerCase().match(/(?:^|[/\s-])(gpt|claude|gemini|deepseek|qwen|llama|grok|o[134])(?=[\d\s.-]|$)/)?.[1]
    ?.replace(/^o[134]$/, "gpt") ?? null;
}

type Props = {
  models: string[];
  model: string;
  primaryModel: string | null;
  disabled?: boolean;
  onSelect: (model: string) => void;
};

export function SessionReviewModelPicker({ models, model, primaryModel, disabled, onSelect }: Props) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const primaryFamily = primaryModel ? family(primaryModel) : null;
  const sameFamily = (id: string) => !!primaryFamily && id !== primaryModel && family(id) === primaryFamily;
  const selected = models.includes(model) ? model : "";
  const choices = filterModelIds(models, query);
  const close = () => { setOpen(false); setQuery(""); };

  return <>
    <button
      ref={anchor}
      type="button"
      className="session-review-chip"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`审查模型：${selected || "未选择"}`}
      title={primaryModel ? `主模型：${primaryModel}（保持不变）` : undefined}
      disabled={disabled}
      onClick={() => setOpen((value) => !value)}
    >
      <span className="session-review-chip-label">审查：{selected || "选择模型"}</span>
      {selected && sameFamily(selected) && <span className="session-review-tag">同系列</span>}
      <ChevronDown size={12} aria-hidden="true" />
    </button>
    <Popover open={open} anchorRef={anchor} onClose={close} label="选择审查模型" className="session-review-models">
      <input
        data-autofocus
        className="session-review-models-search"
        type="search"
        aria-label="搜索审查模型"
        placeholder="搜索模型"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="session-review-models-list" role="listbox" aria-label="审查模型">
        {!choices.length && <p className="session-review-models-empty">{models.length ? "没有匹配的模型" : "没有可用模型"}</p>}
        {choices.map((id) => {
          const primary = id === primaryModel;
          return <button
            key={id}
            type="button"
            role="option"
            aria-selected={id === selected}
            className={`session-review-models-item${primary ? " is-primary" : ""}`}
            title={primary ? "这是当前主模型，建议选择另一模型以获得独立意见" : id}
            onClick={() => { onSelect(id); close(); anchor.current?.focus(); }}
          >
            <span className="session-review-models-check" aria-hidden="true">{id === selected && <Check size={13} />}</span>
            <span className="session-review-models-name">{id}</span>
            {primary && <span className="session-review-tag">主模型</span>}
            {sameFamily(id) && <span className="session-review-tag">同系列</span>}
          </button>;
        })}
      </div>
    </Popover>
  </>;
}
