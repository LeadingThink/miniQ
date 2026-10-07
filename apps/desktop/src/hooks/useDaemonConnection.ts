import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "@capacitor/app";
import { errorMessage } from "../errorMessage";
import { resolveConnection } from "../rpc";
import type { RpcClient } from "../rpc";
import type { ApprovalMode, HealthStatus } from "../types";

interface ConnectionOptions {
  client: RpcClient;
  refreshWorkspaces: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  onError: (message: string | null) => void;
  paused?: boolean;
}

interface ConnectAttemptOptions extends ConnectionOptions {
  isDisposed: () => boolean;
  onConnected: (connected: boolean) => void;
  onHealth: (health: HealthStatus) => void;
  onApprovalMode: (mode: ApprovalMode) => void;
  onProviderConfigured: (configured: boolean) => void;
  onDeviceName: (name: string | null) => void;
  onPhase: (phase: ConnectionPhase) => void;
  onReady: () => void;
  /** Waits before the next attempt; resolves true when a recovery signal cut the wait short. */
  sleep: (ms: number) => Promise<boolean>;
}

export type ConnectionPhase = "connecting" | "connected" | "reconnecting";

export interface RetryContext {
  /** Remote attempts go through the shared relay; local ones hit the daemon on this machine. */
  remote: boolean;
  /** The page is hidden (app in background, e.g. kept alive by the Android service). */
  hidden: boolean;
}

const LOCAL_RETRY_CAP_MS = 5_000;
const REMOTE_RETRY_CAP_MS = 15_000;
const HIDDEN_RETRY_CAP_MS = 60_000;

/**
 * Reconnect delay. The first attempts stay fast so short network blips recover
 * within seconds. Remote retries then slow down so an offline desktop does not
 * make every phone hit the relay every few seconds for hours. Foreground,
 * network-online and manual retry signals interrupt the wait (see `sleep`).
 * Jitter (±20%) keeps phones from reconnecting in lockstep after a relay restart.
 */
export function connectionRetryDelay(
  attempt: number,
  context: RetryContext = { remote: false, hidden: false },
  random: () => number = Math.random,
): number {
  const cap = !context.remote ? LOCAL_RETRY_CAP_MS : context.hidden ? HIDDEN_RETRY_CAP_MS : REMOTE_RETRY_CAP_MS;
  const base = Math.min(500 * 2 ** Math.max(0, attempt - 1), cap);
  if (!context.remote) return base;
  return Math.round(base * (0.8 + 0.4 * random()));
}

export function connectionFailureMessage(error: unknown, reconnecting: boolean): string {
  const suffix = reconnecting ? "miniQ 正在自动重连" : "正在继续尝试连接 miniQ 服务";
  return `${errorMessage(error)}，${suffix}`;
}

async function connectWithRetry(
  options: ConnectAttemptOptions,
  reconnecting: boolean,
): Promise<void> {
  options.onPhase(reconnecting ? "reconnecting" : "connecting");
  let remote = false;
  for (let attempt = 1; !options.isDisposed(); attempt++) {
    try {
      const info = options.client.remoteConnection ?? await resolveConnection();
      if (options.isDisposed()) return;
      remote = info.kind !== "local";
      await options.client.connect(info);
      if (options.isDisposed()) return;
      options.onConnected(true);
      options.onPhase("connected");
      options.onHealth(await options.client.call<HealthStatus>("daemon.health"));
      const settings = await options.client.call<{
        approvalMode?: ApprovalMode;
        provider?: { hasApiKey?: boolean } | null;
        remoteAccess?: { deviceName?: string };
      }>(
        "settings.get",
      );
      if (settings.approvalMode) options.onApprovalMode(settings.approvalMode);
      options.onProviderConfigured(Boolean(settings.provider?.hasApiKey));
      options.onDeviceName(settings.remoteAccess?.deviceName?.trim() || null);
      await options.refreshWorkspaces();
      await options.refreshSessions();
      if (options.isDisposed()) return;
      if (!options.client.connected) throw new Error("连接在同步期间关闭");
      options.onError(null);
      options.onReady();
      return;
    } catch (error) {
      if (options.isDisposed()) return;
      if (attempt === 3) {
        options.onError(connectionFailureMessage(error, reconnecting));
      }
      const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
      const woken = await options.sleep(connectionRetryDelay(attempt, { remote, hidden }));
      // A foreground/online/manual signal means conditions changed: retry now
      // and restart the fast part of the backoff.
      if (woken) attempt = 0;
    }
  }
}

export function useDaemonConnection(options: ConnectionOptions) {
  const [connected, setConnected] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [phase, setPhase] = useState<ConnectionPhase>("connecting");
  const [connectionEpoch, setConnectionEpoch] = useState(0);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("auto");
  const [providerConfigured, setProviderConfigured] = useState<boolean | null>(null);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const recoveryRef = useRef<(() => Promise<void>) | null>(null);
  const { client, refreshWorkspaces, refreshSessions, onError, paused = false } = options;

  useEffect(() => {
    if (paused) return;
    let disposed = false;
    let connectionLoopRunning = false;
    let recovering = false;
    let wakeRetry: (() => void) | null = null;
    const sleep = (ms: number) => new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { wakeRetry = null; resolve(false); }, ms);
      wakeRetry = () => { clearTimeout(timer); wakeRetry = null; resolve(true); };
    });
    const updateRetrying = () => { if (!disposed) setRetrying(connectionLoopRunning || recovering); };
    const connect = async (reconnecting: boolean) => {
      if (connectionLoopRunning || disposed) return;
      connectionLoopRunning = true;
      updateRetrying();
      try { await connectWithRetry(
        {
          client,
          refreshWorkspaces,
          refreshSessions,
          onError,
          isDisposed: () => disposed,
          onConnected: setConnected,
          onHealth: setHealth,
          onApprovalMode: setApprovalMode,
          onProviderConfigured: setProviderConfigured,
          onDeviceName: setDeviceName,
          onPhase: setPhase,
          onReady: () => setConnectionEpoch((current) => current + 1),
          sleep,
        },
        reconnecting,
      ); } finally {
        connectionLoopRunning = false;
        updateRetrying();
      }
    };
    void connect(false);
    const recover = async () => {
      // Capacitor and the DOM both signal a foreground transition. A single
      // probe prevents duplicate transfers and competing reconnect attempts.
      if (disposed || recovering) return;
      if (connectionLoopRunning) {
        // The loop may be in a long remote backoff; retry right away instead.
        wakeRetry?.();
        return;
      }
      recovering = true;
      updateRetrying();
      try {
        if (!client.connected) {
          client.disconnect("foreground recovery");
          void connect(true);
          return;
        }
        try {
          const latest = await client.call<HealthStatus>("daemon.health", undefined, { timeoutMs: 10_000 });
          if (disposed) return;
          setHealth(latest);
        } catch (error) {
          if (disposed) return;
          onError(errorMessage(error));
          client.disconnect("foreground health check failed");
          void connect(true);
          return;
        }
        // A failed catalog read does not mean the authenticated socket failed.
        // Keep it alive so the user can retry without losing pending work.
        const results = await Promise.allSettled([refreshWorkspaces(), refreshSessions()]);
        if (disposed) return;
        const failed = results.find((result) => result.status === "rejected");
        onError(failed?.status === "rejected" ? `同步失败：${errorMessage(failed.reason)}` : null);
        setConnectionEpoch((current) => current + 1);
      } finally {
        recovering = false;
        updateRetrying();
      }
    };
    recoveryRef.current = recover;
    const appStateListener = App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) void recover();
    });
    const visibilityListener = () => {
      if (document.visibilityState === "visible") void recover();
    };
    document.addEventListener("visibilitychange", visibilityListener);
    const onlineListener = () => { void recover(); };
    window.addEventListener("online", onlineListener);
    const offResync = client.onResync(() => {
      setConnectionEpoch((current) => current + 1);
      void refreshSessions().catch((cause) => onError(errorMessage(cause)));
      void refreshWorkspaces().catch((cause) => onError(errorMessage(cause)));
    });
    const offWorkspace = client.onEvent((event) => {
      if (event.type === "workspace_updated" || event.type === "workspace_renamed" || event.type === "workspace_deleted") {
        void refreshWorkspaces().catch((cause) => onError(errorMessage(cause)));
      }
    });
    const offStatus = client.onStatus((isConnected) => {
      setConnected(isConnected);
      if (isConnected) {
        setPhase("connected");
      } else if (!disposed) {
        setPhase("reconnecting");
        void connect(true);
      }
    });
    return () => {
      disposed = true;
      wakeRetry?.();
      if (recoveryRef.current === recover) recoveryRef.current = null;
      offStatus();
      offWorkspace();
      offResync();
      document.removeEventListener("visibilitychange", visibilityListener);
      window.removeEventListener("online", onlineListener);
      void appStateListener.then((listener) => listener.remove());
    };
  }, [client, onError, paused, refreshSessions, refreshWorkspaces]);

  const retryConnection = useCallback(async () => { await recoveryRef.current?.(); }, []);

  const changeApprovalMode = useCallback(
    async (mode: ApprovalMode) => {
      const previous = approvalMode;
      setApprovalMode(mode);
      try {
        await client.call("settings.update", { approvalMode: mode });
      } catch (error) {
        setApprovalMode(previous);
        onError(errorMessage(error));
      }
    },
    [approvalMode, client, onError],
  );

  const refreshProviderConfiguration = useCallback(async () => {
    const settings = await client.call<{
      provider?: { hasApiKey?: boolean } | null;
    }>("settings.get");
    const configured = Boolean(settings.provider?.hasApiKey);
    setProviderConfigured(configured);
    return configured;
  }, [client]);

  return {
    connected,
    phase,
    retrying: paused ? false : retrying,
    retryConnection,
    deviceName,
    connectionEpoch,
    health,
    approvalMode,
    providerConfigured,
    refreshProviderConfiguration,
    changeApprovalMode,
  };
}
