import { useCallback, useId, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { Menu } from "./ui/Menu";

export type AppPlatform = "miniq" | "zaiwen";

const platforms = [
  { id: "zaiwen", name: "在问", description: "查看在问账号的会话" },
  { id: "miniq", name: "miniQ", description: "构建、调试和发布" },
] as const;

export function PlatformSwitcher({ platform, onPlatformChange, zaiwenUser }: {
  platform: AppPlatform;
  onPlatformChange?: (platform: AppPlatform) => void;
  zaiwenUser?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const select = (next: AppPlatform) => {
    // Selecting the current platform must not validate the session or reload it.
    if (next !== platform) onPlatformChange?.(next);
  };

  return <div className="app-menubar-brand" data-tauri-drag-region>
    <button ref={trigger} type="button" className="platform-switcher" aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
      onKeyDown={(event) => {
        if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setOpen(true); }
      }}>
      <img src="./miniq-icon.png" alt="" draggable={false} />
      <span>{platform === "zaiwen" ? "在问" : "miniQ"}</span>
      <ChevronDown size={15} aria-hidden="true" />
    </button>
    <Menu open={open} anchorRef={trigger} onClose={close} label="选择平台" className="platform-switcher-menu">
      {platforms.map((entry) => <button key={entry.id} type="button" role="menuitemradio" tabIndex={-1}
        aria-checked={platform === entry.id} aria-labelledby={`${id}-${entry.id}-name`}
        aria-describedby={`${id}-${entry.id}-description`} onClick={() => select(entry.id)}>
        <span><strong id={`${id}-${entry.id}-name`}>{entry.name}</strong>
          <small id={`${id}-${entry.id}-description`}>{entry.description}</small></span>
        {platform === entry.id && <Check size={18} strokeWidth={1.6} aria-hidden="true" />}
      </button>)}
      {platform === "zaiwen" && zaiwenUser && <p className="platform-switcher-user">已登录：{zaiwenUser}</p>}
    </Menu>
  </div>;
}
