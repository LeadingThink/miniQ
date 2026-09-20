import { Check, ChevronDown, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { useMobileChatModels } from "../hooks/useMobileChatModels";

type Catalog = ReturnType<typeof useMobileChatModels>;

export function MobileModelPicker({ catalog, disabled }: { catalog: Catalog; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialogId = useId();
  const available = !disabled && !catalog.loading && catalog.models.length > 0;
  const close = () => setOpen(false);

  useEffect(() => { if (!available) setOpen(false); }, [available]);

  return <div className="mobile-chat-model-picker">
    <button ref={trigger} type="button" className="mobile-chat-model-trigger" aria-label="问答模型"
      aria-expanded={open && available} aria-haspopup="dialog" aria-controls={dialogId}
      disabled={!available} title={catalog.model} onClick={() => setOpen(true)}>
      <span>{catalog.loading ? "加载模型…" : catalog.model || "选择模型"}</span><ChevronDown size={14} />
    </button>
    {open && available && <ModelDialog catalog={catalog} id={dialogId} trigger={trigger} onClose={close} />}
  </div>;
}

function ModelDialog({ catalog, id, trigger, onClose }: { catalog: Catalog; id: string; trigger: RefObject<HTMLButtonElement>; onClose: () => void }) {
  const [search, setSearch] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const options = useMemo(() => catalog.models.filter((model) => model.toLowerCase().includes(search.trim().toLowerCase())), [catalog.models, search]);

  useEffect(() => {
    const element = dialog.current!;
    // The native top layer keeps this sheet above WKWebView's composited
    // scrolling content and makes the conversation behind it inert.
    element.showModal();
    input.current?.focus({ preventScroll: true });
    return () => { element.close(); trigger.current?.focus({ preventScroll: true }); };
  }, [trigger]);

  return createPortal(<dialog ref={dialog} id={id} className="mobile-chat-model-dialog" aria-labelledby={`${id}-title`}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <header className="mobile-chat-model-heading">
      <h2 id={`${id}-title`}>选择问答模型</h2>
      <button type="button" className="icon-button" aria-label="关闭模型选择" onClick={onClose}><X size={18} /></button>
    </header>
    <input ref={input} className="mobile-chat-model-search" aria-label="搜索模型" placeholder="搜索文本模型" type="search"
      value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); results.current?.querySelector<HTMLButtonElement>("[role=option]")?.focus(); }
      }} />
    <div ref={results} className="mobile-chat-model-results" role="listbox" aria-label="可用文本模型" onKeyDown={(event) => {
      const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=option]")];
      const current = items.indexOf(event.target as HTMLButtonElement);
      const next = event.key === "ArrowDown" ? Math.min(current + 1, items.length - 1)
        : event.key === "ArrowUp" ? Math.max(current - 1, 0)
          : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
      if (next !== null) { event.preventDefault(); items[next]?.focus(); }
    }}>
      {options.map((model) => <button type="button" role="option" aria-selected={model === catalog.model} key={model}
        onClick={() => { catalog.selectModel(model); onClose(); }}>
        <span>{model}</span>{model === catalog.model && <Check size={16} aria-hidden="true" />}
      </button>)}
      {!options.length && <p role="status">没有匹配的文本模型</p>}
    </div>
  </dialog>, document.body);
}
