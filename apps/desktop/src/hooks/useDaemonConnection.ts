import { useCallback, useEffect, useState } from "react";
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
  onPhase: (phase: ConnectionPhase) => void;
  onReady: () => void;
}

export type ConnectionPhase = "connecting" | "connected" | "reconnecting";

export function connectionRetryDelay(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt - 1), 5_000);
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
  for (let attempt = 1; !options.isDisposed(); attempt++) {
    try {
      const info = await resolveConnection(options.client.sshHost);
      if (options.isDisposed()) return;
      await options.client.connect(info);
      if (options.isDisposed()) return;
      options.onConnected(true);
      options.onPhase("connected");
      options.onHealth(await options.client.call<HealthStatus>("daemon.health"));
      const settings = await options.client.call<{
        approvalMode?: ApprovalMode;
        provider?: { hasApiKey?: boolean } | null;
      }>(
        "settings.get",
      );
      if (settings.approvalMode) options.onApprovalMode(settings.approvalMode);
      options.onProviderConfigured(Boolean(settings.provider?.hasApiKey));
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
      await new Promise((resolve) =>
        setTimeout(resolve, connectionRetryDelay(attempt)),
      );
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
  const { client, refreshWorkspaces, refreshSessions, onError, paused = false } = options;

  useEffect(() => {
    if (paused) return;
    let disposed = false;
    let connectionLoopRunning = false;
    let recovering = false;
    const connect = async (reconnecting: boolean) => {
      if (connectionLoopRunning || disposed) return;
      connectionLoopRunning = true;
      await connectWithRetry(
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
          onPhase: setPhase,
          onReady: () => setConnectionEpoch((current) => current + 1),
        },
        reconnecting,
      );
      connectionLoopRunning = false;
    };
    void connect(false);
    const recover = async () => {
      // Capacitor and the DOM both signal a foreground transition. A single
      // probe prevents duplicate transfers and competing reconnect attempts.
      if (disposed || recovering || connectionLoopRunning) return;
      recovering = true;
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
      }
    };
    const appStateListener = App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) void recover();
    });
    const visibilityListener = () => {
      if (document.visibilityState === "visible") void recover();
    };
    document.addEventListener("visibilitychange", visibilityListener);
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
      offStatus();
      offWorkspace();
      offResync();
      document.removeEventListener("visibilitychange", visibilityListener);
      void appStateListener.then((listener) => listener.remove());
    };
  }, [client, onError, paused, refreshSessions, refreshWorkspaces]);

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
    connectionEpoch,
    health,
    approvalMode,
    providerConfigured,
    refreshProviderConfiguration,
    changeApprovalMode,
  };
}
