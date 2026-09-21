import {
  ArrowLeft,
  FileDiff,
  Files,
  Globe2,
  LayoutList,
  Maximize2,
  Minimize2,
  X,
} from "lucide-react";
import { useId } from "react";
import type { WorkbenchView } from "../hooks/useAppWorkbench";
import "./WorkbenchToolbar.css";

export function WorkbenchToolbar(props: {
  active: WorkbenchView;
  files: number;
  browsers: number;
  changes: number;
  remote: boolean;
  hasSession: boolean;
  canPreviewFiles?: boolean;
  expanded: boolean;
  mobile?: boolean;
  onSelect: (view: WorkbenchView) => void;
  onExpand: () => void;
  onClose: () => void;
}) {
  const id = useId();
  const sections = [
    {
      key: "overview",
      label: "概览",
      icon: LayoutList,
      count: 0,
      disabled: false,
    },
    {
      key: "files",
      label: "文件",
      icon: Files,
      count: props.files,
      disabled: !(props.canPreviewFiles ?? props.hasSession),
    },
    {
      key: "browser",
      label: props.remote ? "网页记录" : "浏览器",
      icon: Globe2,
      count: props.browsers,
      disabled: props.remote && !props.hasSession,
    },
    {
      key: "review",
      label: "审阅",
      icon: FileDiff,
      count: props.changes,
      disabled: !props.hasSession,
    },
  ] as const;
  return (
    <header className="workbench-toolbar" aria-label="工作面板">
      {props.mobile && <button type="button" className="workbench-back" onClick={props.onClose}><ArrowLeft size={18} />返回会话</button>}
      <div role="tablist" aria-label="工作面板内容">
        {sections.map(({ key, label, icon: Icon, count, disabled }) => (
          <button
            type="button"
            key={key}
            id={`${id}-${key}`}
            role="tab"
            aria-selected={props.active === key}
            aria-controls="miniq-workbench-content"
            tabIndex={props.active === key ? 0 : -1}
            disabled={disabled}
            onClick={() => props.onSelect(key)}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const available = sections.filter((item) => !item.disabled);
              const index = available.findIndex((item) => item.key === key);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? available.length - 1
                    : (index +
                        (event.key === "ArrowLeft" ? -1 : 1) +
                        available.length) %
                      available.length;
              props.onSelect(available[next].key);
              document.getElementById(`${id}-${available[next].key}`)?.focus();
            }}
          >
            <Icon size={15} />
            <span>{label}</span>
            {count > 0 && <small>{count}</small>}
          </button>
        ))}
      </div>
      {!props.mobile && <button
        type="button"
        className="icon-button"
        title={props.expanded ? "恢复分栏（Esc）" : "展开工作面板"}
        aria-label={props.expanded ? "恢复工作面板分栏" : "展开工作面板"}
        aria-pressed={props.expanded}
        onClick={(event) => {
          event.currentTarget.focus();
          props.onExpand();
        }}
      >
        {props.expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>}
      {!props.mobile && <button
        type="button"
        className="icon-button"
        title="隐藏工作面板，保留打开的标签"
        aria-label="隐藏工作面板"
        onClick={props.onClose}
      >
        <X size={16} />
      </button>}
    </header>
  );
}
