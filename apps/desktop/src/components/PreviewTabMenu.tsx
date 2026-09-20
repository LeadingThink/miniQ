import { Check, ChevronDown, RotateCcw, Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { LocalFileTarget } from "../localFiles";

export interface PreviewTabActions {
  onCloseOthers?: (path: string) => void;
  onCloseAll?: () => void;
  onReopenClosed?: () => void;
  canReopenClosed?: boolean;
}

export function PreviewTabMenu(
  props: PreviewTabActions & {
    tabs: LocalFileTarget[];
    active: string;
    onSelect: (target: LocalFileTarget) => void;
    onClose: (path: string) => void;
  },
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const matching = props.tabs.filter((target) =>
    target.path.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  const dismiss = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const outside = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open]);
  const select = (target: LocalFileTarget) => {
    setOpen(false);
    props.onSelect(target);
  };
  return (
    <div
      className="preview-tab-menu"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="icon-button preview-tab-menu-trigger"
        aria-label={`文件标签管理，${props.tabs.length} 个已打开`}
        title="查找与管理打开的文件"
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        onClick={() => {
          setQuery("");
          setOpen((value) => !value);
        }}
      >
        <ChevronDown size={14} />
        <span>{props.tabs.length}</span>
      </button>
      {open && (
        <section
          id={id}
          className="preview-tab-popover"
          role="dialog"
          aria-label="查找与管理文件标签"
        >
          <label className="preview-tab-search">
            <Search size={14} />
            <input
              ref={input}
              value={query}
              placeholder="搜索文件名或路径"
              aria-label="搜索打开的文件"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (
                  (event.key === "ArrowDown" || event.key === "Enter") &&
                  matching.length
                ) {
                  event.preventDefault();
                  if (event.key === "Enter") select(matching[0]);
                  else
                    root.current
                      ?.querySelector<HTMLButtonElement>(
                        ".preview-tab-result-select",
                      )
                      ?.focus();
                }
              }}
            />
          </label>
          <div className="preview-tab-results" aria-label="文件搜索结果">
            {matching.map((target, index) => (
              <div key={target.path} className="preview-tab-result">
                <button
                  type="button"
                  className="preview-tab-result-select"
                  title={target.path}
                  aria-current={
                    target.path === props.active ? "true" : undefined
                  }
                  onClick={() => select(target)}
                  onKeyDown={(event) => {
                    if (
                      !["ArrowDown", "ArrowUp", "Home", "End"].includes(
                        event.key,
                      )
                    )
                      return;
                    event.preventDefault();
                    if (event.key === "ArrowUp" && index === 0) {
                      input.current?.focus();
                      return;
                    }
                    const next =
                      event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? matching.length - 1
                          : (index +
                              (event.key === "ArrowDown" ? 1 : -1) +
                              matching.length) %
                            matching.length;
                    root.current
                      ?.querySelectorAll<HTMLButtonElement>(
                        ".preview-tab-result-select",
                      )
                      [next]?.focus();
                  }}
                >
                  <span>
                    <strong>{target.path.split(/[\\/]/).at(-1)}</strong>
                    <small>{target.path}</small>
                  </span>
                  {target.path === props.active && <Check size={14} />}
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`从列表关闭文件 ${target.path}`}
                  title="关闭文件"
                  onClick={() => {
                    props.onClose(target.path);
                    input.current?.focus();
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            {!matching.length && (
              <p className="preview-tab-empty">
                {query.trim() ? "没有匹配的文件" : "没有打开的文件"}
              </p>
            )}
          </div>
          <footer className="preview-tab-actions">
            {props.onReopenClosed && (
              <button
                type="button"
                disabled={!props.canReopenClosed}
                onClick={() => {
                  dismiss();
                  props.onReopenClosed?.();
                }}
              >
                <RotateCcw size={13} />
                重新打开已关闭文件
              </button>
            )}
            {props.onCloseOthers && (
              <button
                type="button"
                disabled={props.tabs.length < 2}
                onClick={() => {
                  dismiss();
                  props.onCloseOthers?.(props.active);
                }}
              >
                关闭其他文件
              </button>
            )}
            {props.onCloseAll && (
              <button
                type="button"
                disabled={!props.tabs.length}
                onClick={() => {
                  dismiss();
                  props.onCloseAll?.();
                }}
              >
                关闭全部文件
              </button>
            )}
          </footer>
        </section>
      )}
    </div>
  );
}
