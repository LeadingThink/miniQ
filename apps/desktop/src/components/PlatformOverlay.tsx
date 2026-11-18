import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { signalPlatformOverlayAction as signal, type PlatformOverlaySnapshot } from "../platformOverlay";
import { Menu } from "./ui/Menu";
import { PlatformMenu } from "./PlatformMenu";

// This local overlay can invoke only its dedicated action command.
declare global {
  interface Window {
    __MINIQ_PLATFORM__?: PlatformOverlaySnapshot;
    __MINIQ_SET_PLATFORM__?: (snapshot: PlatformOverlaySnapshot) => void;
  }
}

export default function PlatformOverlay() {
  const [snapshot, setSnapshot] = useState(() => window.__MINIQ_PLATFORM__);
  const [error, setError] = useState<string | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const send = useCallback((action: "close" | "miniq" | "zaiwen") => {
    setError(null);
    void signal(action).catch((cause) => setError(String(cause)));
  }, []);
  const close = useCallback(() => send("close"), [send]);
  useLayoutEffect(() => {
    window.__MINIQ_SET_PLATFORM__ = (next) => { setError(null); setSnapshot(next); };
    setSnapshot(window.__MINIQ_PLATFORM__);
    return () => { delete window.__MINIQ_SET_PLATFORM__; };
  }, []);
  if (!snapshot) return null;
  return <>
    <span ref={anchor} className="platform-overlay-anchor" aria-hidden="true" style={{
      left: snapshot.anchor.left, top: snapshot.anchor.top,
      width: snapshot.anchor.width, height: snapshot.anchor.height,
    }} onMouseDown={close} />
    <Menu key={snapshot.requestId} open anchorRef={anchor} onClose={close} closeOnSelect={false} label="选择平台" className="platform-switcher-menu">
      <PlatformMenu platform={snapshot.platform} onSelect={send} />
      {error && <p role="alert" className="platform-overlay-error">无法切换：{error}</p>}
    </Menu>
  </>;
}
