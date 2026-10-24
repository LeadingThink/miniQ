import { Fragment, useCallback, useRef, useState, type KeyboardEvent } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { MiniqAppController } from "../hooks/useMiniqApp";
import { dispatchCommand, shortcutLabel } from "../shortcuts";
import { captureEditingTarget } from "../menuEditing";
import { isMacDesktop, isWindowsDesktop } from "../windowChrome";
import { Menu, MenuItem, MenuSeparator } from "./ui/Menu";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { WindowControls } from "./WindowControls";
import { appMenuItems } from "./appMenuItems";
import { version } from "../../package.json";
import "./AppMenuBar.css";

const LABELS = ["文件", "编辑", "视图", "帮助"];

export function AppMenuBar({ app }: { app: MiniqAppController | null }) {
  const [open, setOpen] = useState<number | null>(null);
  const [focused, setFocused] = useState(0);
  const [about, setAbout] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const openedByHover = useRef<number | null>(null);
  const restoreEditor = useRef<() => void>(() => undefined);
  const close = useCallback(() => setOpen(null), []);
  const reportError = useCallback((message: string) => app?.setError(message), [app?.setError]);
  const groups = appMenuItems(app, () => restoreEditor.current(), () => setAbout(true));
  const show = (index: number) => { anchor.current = buttons.current[index]; setFocused(index); setOpen(index); };
  const navigate = (event: KeyboardEvent, index: number, inMenu = false) => {
    const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (offset || (!inMenu && ["Home", "End"].includes(event.key))) {
      event.preventDefault(); event.stopPropagation();
      const next = offset ? (index + offset + LABELS.length) % LABELS.length : event.key === "Home" ? 0 : LABELS.length - 1;
      setFocused(next);
      if (open !== null) show(next);
      else buttons.current[next]?.focus();
    } else if (!inMenu && ["ArrowDown", "Enter", " "].includes(event.key)) {
      event.preventDefault(); show(index);
    } else if (!inMenu && event.key === "Escape") {
      event.preventDefault(); close();
    }
  };
  const sidebarLabel = app?.navigation.sidebarCollapsed ? "显示侧栏" : "隐藏侧栏";
  return <>
    <header className="app-menubar" data-tauri-drag-region>
      <div className="app-menubar-brand" data-tauri-drag-region>
        <img src="./miniq-icon.png" alt="" draggable={false} data-tauri-drag-region />
        <span data-tauri-drag-region>miniQ</span>
      </div>
      <button type="button" className="app-menubar-sidebar" aria-label={sidebarLabel} title={`${sidebarLabel}（${shortcutLabel("toggleSidebar")}）`}
        disabled={!app} onClick={() => dispatchCommand("toggleSidebar")}>
        {app?.navigation.sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </button>
      {!isMacDesktop() && <nav role="menubar" aria-label="应用菜单" className="app-menubar-nav"
        onMouseDownCapture={() => { if (open === null) restoreEditor.current = captureEditingTarget(); }}
        onFocusCapture={(event) => {
          if (open === null && event.relatedTarget instanceof HTMLElement && !event.currentTarget.contains(event.relatedTarget)) {
            restoreEditor.current = captureEditingTarget(event.relatedTarget);
          }
        }}>
        {LABELS.map((label, index) => <button key={label} ref={(node) => { buttons.current[index] = node; }}
          type="button" role="menuitem" aria-haspopup="menu" aria-expanded={open === index} tabIndex={focused === index ? 0 : -1}
          className="app-menubar-trigger" onFocus={() => setFocused(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (open === index && openedByHover.current !== index) close(); else show(index);
            openedByHover.current = null;
          }}
          onMouseEnter={() => { if (open !== null && open !== index) { openedByHover.current = index; show(index); } }}
          onMouseLeave={() => { openedByHover.current = null; }}
          onKeyDown={(event) => navigate(event, index)}>{label}</button>)}
      </nav>}
      <div className="app-menubar-drag" data-tauri-drag-region />
      {isWindowsDesktop() && <WindowControls onError={reportError} />}
    </header>
    {open !== null && <Menu key={open} open anchorRef={anchor} onClose={close} label={LABELS[open]} className="app-menubar-dropdown"
      onKeyDown={(event) => navigate(event, open, true)}>
      {groups[open].map((group, index) => <Fragment key={index}>
        {index > 0 && <MenuSeparator />}
        {group.map((item) => <MenuItem key={item.label} shortcut={item.shortcut} disabled={item.disabled} onClick={() => {
          // The menu restores its trigger first; commands then focus their own destination.
          queueMicrotask(() => { void Promise.resolve().then(item.run).catch((error) => reportError(String(error))); });
        }}>{item.label}</MenuItem>)}
      </Fragment>)}
    </Menu>}
    <Dialog open={about} title="关于 miniQ" description={`版本 ${version}`} onClose={() => setAbout(false)}
      footer={<Button variant="secondary" onClick={() => setAbout(false)}>关闭</Button>}>
      <p>与 AI 一起，把想法变成作品。</p>
    </Dialog>
  </>;
}
