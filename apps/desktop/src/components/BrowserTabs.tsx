import { Globe2, Plus, X } from "lucide-react";
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
  return <div className="browser-tabs" role="tablist" aria-label="打开的网页">
    {props.tabs.map((tab) => <div className={`browser-tab ${tab.id === props.activeId ? "active" : ""}`} key={tab.id}>
      <button type="button" role="tab" aria-selected={tab.id === props.activeId} title={tab.url} onClick={() => props.onSelect(tab.id)}>
        <Globe2 size={13} /><span>{hostLabel(tab.url)}</span>
      </button>
      <button type="button" className="icon-button" aria-label="关闭网页标签" title="关闭标签" onClick={() => props.onClose(tab.id)}><X size={12} /></button>
    </div>)}
    <button type="button" className="icon-button browser-new-tab" title="新建网页标签" aria-label="新建网页标签" onClick={props.onNew}><Plus size={15} /></button>
  </div>;
}
