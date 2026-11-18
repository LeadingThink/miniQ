import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Menu } from "./ui/Menu";
import { PlatformMenu } from "./PlatformMenu";
import { closePlatformOverlay, listenPlatformOverlayAction, openPlatformOverlay } from "../platformOverlay";
import { errorMessage } from "../errorMessage";
import { isTauriRuntime } from "../runtime";
import type { AppPlatform } from "../platforms";

export type { AppPlatform } from "../platforms";

export function PlatformSwitcher({ platform, onPlatformChange }: {
  platform: AppPlatform;
  onPlatformChange?: (platform: AppPlatform) => void;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const native = isTauriRuntime();
  const trigger = useRef<HTMLButtonElement>(null);
  const selection = useRef({ platform, onPlatformChange });
  selection.current = { platform, onPlatformChange };
  const close = useCallback(() => setOpen(false), []);
  const select = useCallback((next: AppPlatform) => {
    const current = selection.current;
    if (next !== current.platform) current.onPlatformChange?.(next);
  }, []);

  useEffect(() => {
    if (!native) return;
    return listenPlatformOverlayAction((action) => {
      close();
      if (action !== "close") select(action);
      trigger.current?.focus();
    });
  }, [native, close, select]);

  useEffect(() => {
    if (!native || !open) return;
    let disposed = false;
    const show = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      void openPlatformOverlay({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }, {
        platform, requestId: crypto.randomUUID(),
        anchor: { left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height },
      }).catch((cause) => {
        if (!disposed) { setError(errorMessage(cause)); close(); }
      });
    };
    show();
    window.addEventListener("resize", show);
    return () => {
      disposed = true;
      window.removeEventListener("resize", show);
      void closePlatformOverlay().catch((cause) => setError(errorMessage(cause)));
    };
  }, [native, open, platform, close]);

  return <div className="app-menubar-brand" data-tauri-drag-region>
    <button ref={trigger} type="button" className="platform-switcher" aria-haspopup="menu" aria-expanded={open}
      onClick={() => { setError(null); setOpen((value) => !value); }}
      onKeyDown={(event) => {
        if (["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setError(null); setOpen(true); }
      }}>
      <img src="./miniq-icon.png" alt="" draggable={false} />
      <span>{platform === "zaiwen" ? "在问" : "miniQ"}</span>
      <ChevronDown size={15} aria-hidden="true" />
    </button>
    {error && <span className="platform-switcher-error" role="alert">{error}</span>}
    <Menu open={open && !native} anchorRef={trigger} onClose={close} label="选择平台" className="platform-switcher-menu">
      <PlatformMenu platform={platform} onSelect={select} />
    </Menu>
  </div>;
}
