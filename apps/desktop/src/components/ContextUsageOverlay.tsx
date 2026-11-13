import { useEffect, useState } from "react";
import type { ContextUsageOverlaySnapshot } from "../contextUsageOverlay";
import { ContextUsagePanel } from "./ContextUsagePanel";
import "./ContextUsageControl.css";

const empty: ContextUsageOverlaySnapshot = { usage: null, loading: true, error: null };

declare global {
  interface Window {
    __MINIQ_CONTEXT_USAGE__?: ContextUsageOverlaySnapshot;
    __MINIQ_SET_CONTEXT_USAGE__?: (snapshot: ContextUsageOverlaySnapshot) => void;
  }
}

function signal(action: "close" | "refresh") {
  window.location.href = `miniq-overlay://${action}`;
}

export default function ContextUsageOverlay() {
  const [snapshot, setSnapshot] = useState(() => window.__MINIQ_CONTEXT_USAGE__ ?? empty);

  useEffect(() => {
    window.__MINIQ_SET_CONTEXT_USAGE__ = setSnapshot;
    return () => { delete window.__MINIQ_SET_CONTEXT_USAGE__; };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") signal("close");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return <main className="ui-popover context-usage-popover context-usage-overlay" role="dialog" aria-label="上下文用量">
    <ContextUsagePanel {...snapshot} onRefresh={() => signal("refresh")} onClose={() => signal("close")} />
  </main>;
}
