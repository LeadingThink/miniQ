import { Globe2, Plus, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { BrowserTab } from "../browserTabs";
import "./BrowserTabs.css";

function hostLabel(url: string) {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

export function BrowserTabs(props: {
  tabs: BrowserTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    const active = list.current?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    active?.parentElement?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    if (restoreFocus.current) {
      restoreFocus.current = false;
      (active ?? list.current?.querySelector<HTMLButtonElement>(".browser-new-tab"))?.focus({ preventScroll: true });
    }
  }, [props.activeId, props.tabs]);
  const close = (id: string) => {
    restoreFocus.current = true;
    props.onClose(id);
  };
  return <div ref={list} className="browser-tabs" role="tablist" aria-label="打开的网页">
    {props.tabs.map((tab) => <div className={`browser-tab ${tab.id === props.activeId ? "active" : ""}`} key={tab.id}>
      <button type="button" role="tab" aria-selected={tab.id === props.activeId} tabIndex={tab.id === props.activeId ? 0 : -1} title={tab.url} onClick={() => props.onSelect(tab.id)} onKeyDown={(event) => {
        if (event.key === "Delete") {
          event.preventDefault();
          close(tab.id);
          return;
        }
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const index = props.tabs.findIndex((item) => item.id === tab.id);
        const next = event.key === "Home" ? 0 : event.key === "End" ? props.tabs.length - 1 :
          (index + (event.key === "ArrowLeft" ? -1 : 1) + props.tabs.length) % props.tabs.length;
        restoreFocus.current = true;
        props.onSelect(props.tabs[next].id);
      }}>
        <Globe2 size={13} /><span>{hostLabel(tab.url)}</span>
      </button>
      <button type="button" className="icon-button" aria-label={`关闭网页标签 ${hostLabel(tab.url)}`} title="关闭标签" onClick={() => close(tab.id)}><X size={12} /></button>
    </div>)}
    <button type="button" className="icon-button browser-new-tab" title="新建网页标签" aria-label="新建网页标签" onClick={props.onNew}><Plus size={15} /></button>
  </div>;
}
