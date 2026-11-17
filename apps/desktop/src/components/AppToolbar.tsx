import type { ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import "./AppStatus.css";

/** The same conversation header for local and API-backed sessions. */
export function AppToolbar(props: {
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  title: ReactNode;
  actions: ReactNode;
}) {
  const label = `${props.sidebarCollapsed ? "显示" : "隐藏"}侧栏`;
  return <div className="statusbar app-toolbar" data-tauri-drag-region>
    <button type="button" className="statusbar-icon-button app-toolbar-sidebar"
      data-tooltip={`${label}（⌘/Ctrl+B）`} title={`${label}（⌘/Ctrl+B）`} aria-label={label}
      onClick={props.onToggleSidebar}>
      {props.sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
    </button>
    <div className="app-toolbar-title" data-tauri-drag-region>{props.title}</div>
    <div className="app-toolbar-actions">{props.actions}</div>
  </div>;
}
