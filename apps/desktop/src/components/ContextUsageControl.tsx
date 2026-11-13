import { useCallback, useEffect, useRef, useState } from "react";
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
  const [surface, setSurface] = useState<"fallback" | "pending" | "native">("fallback");
  const trigger = useRef<HTMLButtonElement>(null);
  const request = useRef(0);
  const close = useCallback(() => {
    request.current += 1;
    setOpened(null);
    setSurface("fallback");
    void closeContextUsageOverlay();
    trigger.current?.focus();
  }, []);
  const percent = usage?.percentUsed ?? null;
  const warning = !!usage && usage.estimatedTokens >= usage.autoCompactTokens;

  useEffect(() => listenContextUsageOverlayAction((action) => {
    if (action === "close") close();
    else void refresh();
  }), [close, refresh]);

  useEffect(() => {
    if (surface !== "native") return;
    void updateContextUsageOverlay({ usage, loading, error });
  }, [error, loading, surface, usage]);

  useEffect(() => {
    if (opened !== null && opened !== sessionId) close();
  }, [close, opened, sessionId]);

  useEffect(() => () => { void closeContextUsageOverlay(); }, []);

  const open = () => {
    if (!sessionId) return;
    setOpened(sessionId);
    void refresh();
    if (!isTauriRuntime()) {
      setSurface("fallback");
      return;
    }
    const bounds = trigger.current?.getBoundingClientRect();
    if (!bounds) return;
    const currentRequest = request.current + 1;
    request.current = currentRequest;
    setSurface("pending");
    void openContextUsageOverlay(
      contextUsageOverlayBounds(bounds, window.innerWidth, window.innerHeight),
      { usage, loading: true, error: null },
    ).then(
      () => { if (request.current === currentRequest) setSurface("native"); },
      () => { if (request.current === currentRequest) setSurface("fallback"); },
    );
  };

  return <>
    <button ref={trigger} type="button" className={`context-usage-trigger${warning ? " is-warning" : ""}`}
      aria-label="上下文用量" aria-haspopup="dialog" aria-expanded={opened !== null && opened === sessionId}
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
    <Popover open={surface === "fallback" && opened !== null && opened === sessionId} anchorRef={trigger} onClose={close}
      label="上下文用量" className="context-usage-popover" layer="non-modal">
      <ContextUsagePanel usage={usage} loading={loading} error={error}
        onRefresh={() => void refresh()} onClose={close} />
    </Popover>
  </>;
}
