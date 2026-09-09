import { File, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import type { LocalFileTarget } from "../localFiles";
import { previewTabDirectories } from "../previewTabs";
import "./PreviewTabs.css";

export function PreviewTabs(props: {
  tabs: LocalFileTarget[];
  active: string;
  id: string;
  onSelect: (target: LocalFileTarget) => void;
  onClose: (path: string) => void;
}) {
  const restoreFocus = useRef(false);
  const directories = useMemo(
    () => previewTabDirectories(props.tabs),
    [props.tabs],
  );
  useEffect(() => {
    const index = props.tabs.findIndex(
      (target) => target.path === props.active,
    );
    const active = document.getElementById(`${props.id}-${index}`);
    active?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    if (restoreFocus.current) {
      restoreFocus.current = false;
      active?.focus({ preventScroll: true });
    }
  }, [props.tabs, props.active, props.id]);
  if (!props.tabs.length) return null;
  return (
    <div className="preview-tabs" role="tablist" aria-label="打开的文件">
      {props.tabs.map((target, index) => (
        <div className="preview-tab" key={target.path}>
          <button
            type="button"
            role="tab"
            id={`${props.id}-${index}`}
            title={target.path}
            aria-selected={props.active === target.path}
            aria-controls={props.id}
            tabIndex={props.active === target.path ? 0 : -1}
            onClick={() => props.onSelect(target)}
            onKeyDown={(event) => {
              if (event.key === "Delete") {
                event.preventDefault();
                restoreFocus.current = true;
                props.onClose(target.path);
                return;
              }
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? props.tabs.length - 1
                    : (index +
                        (event.key === "ArrowLeft" ? -1 : 1) +
                        props.tabs.length) %
                      props.tabs.length;
              props.onSelect(props.tabs[next]);
              document.getElementById(`${props.id}-${next}`)?.focus();
            }}
          >
            <File size={13} />
            <span>
              {target.path.split(/[\\/]/).at(-1)}
              {directories.has(target.path) && (
                <small>{directories.get(target.path)}</small>
              )}
            </span>
          </button>
          <button
            type="button"
            className="icon-button"
            title={`关闭 ${target.path}`}
            aria-label={`关闭文件 ${target.path}`}
            onClick={() => {
              restoreFocus.current = true;
              props.onClose(target.path);
            }}
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
