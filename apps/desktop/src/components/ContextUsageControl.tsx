import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RpcClient } from "../rpc";
import {
  closeContextUsageOverlay,
  contextUsageOverlayBounds,
  listenContextUsageOverlayAction,
  openContextUsageOverlay,
  updateContextUsageOverlay,
} from "../contextUsageOverlay";
import { useContextUsage } from "../hooks/useContextUsage";
import { isTauriRuntime } from "../runtime";
import { ContextUsagePanel } from "./ContextUsagePanel";
import { Popover } from "./ui/Popover";
import "./ContextUsageControl.css";

export function ContextUsageControl({ client, sessionId }: { client: RpcClient; sessionId: string | null }) {
  const { usage, loading, error, refresh } = useContextUsage(client, sessionId);
  const [opened, setOpened] = useState<string | null>(null);
  const [surface, setSurface] = useState<"fallback" | "native">("fallback");
  const trigger = useRef<HTMLButtonElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const request = useRef(0);
  const overlayRequested = useRef(false);
  const close = useCallback(() => {
    request.current += 1;
    overlayRequested.current = false;
    setOpened(null);
    setSurface("fallback");
    void closeContextUsageOverlay();
    trigger.current?.focus();
  }, []);
  const percent = usage?.percentUsed ?? null;
  const warning = !!usage && usage.estimatedTokens >= usage.autoCompactTokens;
  const isOpen = opened !== null && opened === sessionId;
  const nativeOpen = isOpen && surface === "native";

  useEffect(() => listenContextUsageOverlayAction((action) => {
    if (action === "close") close();
    else void refresh();
  }), [close, refresh]);

  // The native overlay is sized from the hidden copy, so it always hugs its content.
  useLayoutEffect(() => {
    const anchor = trigger.current;
    const panel = measure.current;
    if (!nativeOpen || !anchor || !panel) return;
    const bounds = contextUsageOverlayBounds(
      anchor.getBoundingClientRect(),
      panel.getBoundingClientRect(),
      window.innerWidth,
      window.innerHeight,
    );
    const snapshot = { usage, loading, error };
    if (overlayRequested.current) {
      void updateContextUsageOverlay(bounds, snapshot);
      return;
    }
    overlayRequested.current = true;
    const currentRequest = request.current;
    openContextUsageOverlay(bounds, snapshot).catch(() => {
      if (request.current === currentRequest) setSurface("fallback");
    });
  }, [error, loading, nativeOpen, usage]);

  useEffect(() => {
    if (opened !== null && opened !== sessionId) close();
  }, [close, opened, sessionId]);

  useEffect(() => () => { void closeContextUsageOverlay(); }, []);

  const open = () => {
    if (!sessionId) return;
    setOpened(sessionId);
    setSurface(isTauriRuntime() ? "native" : "fallback");
    void refresh();
  };

  return <>
    <button ref={trigger} type="button" className={`context-usage-trigger${warning ? " is-warning" : ""}`}
      aria-label="上下文用量" aria-haspopup="dialog" aria-expanded={isOpen}
      disabled={!sessionId} title={percent === null ? "上下文用量：容量未知" : `上下文用量：${percent.toFixed(1)}%（估算）`}
      onClick={() => {
        if (opened === sessionId) close();
        else open();
      }}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="context-usage-track" cx="12" cy="12" r="9" />
        {percent !== null && <circle className="context-usage-fill" cx="12" cy="12" r="9" pathLength="100"
          strokeDasharray={`${Math.min(100, Math.max(0, percent))} 100`} />}
      </svg>
    </button>
    {nativeOpen && <div ref={measure} className="ui-popover context-usage-popover context-usage-measure" aria-hidden="true">
      <ContextUsagePanel usage={usage} loading={loading} error={error} onRefresh={() => undefined} onClose={() => undefined} />
    </div>}
    <Popover open={isOpen && surface === "fallback"} anchorRef={trigger} onClose={close}
      label="上下文用量" className="context-usage-popover" layer="non-modal">
      <ContextUsagePanel usage={usage} loading={loading} error={error}
        onRefresh={() => void refresh()} onClose={close} />
    </Popover>
  </>;
}
