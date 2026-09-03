import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../errorMessage";
import { resolveConnection } from "../rpc";
import type { RpcClient } from "../rpc";
import type { ApprovalMode, HealthStatus } from "../types";

const PROTOCOL_VERSION = 2;

interface ConnectionOptions {
  client: RpcClient;
  refreshWorkspaces: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  onError: (message: string | null) => void;
}

interface ConnectAttemptOptions extends ConnectionOptions {
  isDisposed: () => boolean;
  onConnected: (connected: boolean) => void;
  onHealth: (health: HealthStatus) => void;
  onApprovalMode: (mode: ApprovalMode) => void;
  onPhase: (phase: ConnectionPhase) => void;
  onReady: () => void;
}

export type ConnectionPhase = "connecting" | "connected" | "reconnecting";

export function connectionRetryDelay(attempt: number): number {
  return Math.min(500 * 2 ** Math.max(0, attempt - 1), 5_000);
}

async function connectWithRetry(
  options: ConnectAttemptOptions,
  reconnecting: boolean,
): Promise<void> {
  options.onPhase(reconnecting ? "reconnecting" : "connecting");
  for (let attempt = 1; !options.isDisposed(); attempt++) {
    try {
      const info = await resolveConnection();
      await options.client.connect(info);
      if (options.isDisposed()) return;
      options.onConnected(true);
      const health = await options.client.call<HealthStatus>("daemon.health");
      if (health.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(
          `daemon protocol ${health.protocolVersion} is incompatible with desktop protocol ${PROTOCOL_VERSION}; restart miniQ to use the updated daemon`,
        );
      }
      options.onPhase("connected");
      options.onHealth(health);
      const settings = await options.client.call<{ approvalMode?: ApprovalMode }>(
        "settings.get",
      );
      if (settings.approvalMode) options.onApprovalMode(settings.approvalMode);
      await options.refreshWorkspaces();
      await options.refreshSessions();
      options.onError(null);
      options.onReady();
      return;
    } catch (error) {
      if (options.isDisposed()) return;
      if (attempt === 3) {
        options.onError(`${errorMessage(error)}，miniQ 正在自动重连`);
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
  const { client, refreshWorkspaces, refreshSessions, onError } = options;

  useEffect(() => {
    let disposed = false;
    let connectionLoopRunning = false;
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
          onPhase: setPhase,
          onReady: () => setConnectionEpoch((current) => current + 1),
        },
        reconnecting,
      );
      connectionLoopRunning = false;
    };
    void connect(false);
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
    };
  }, [client, onError, refreshSessions, refreshWorkspaces]);

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

  return {
    connected,
    phase,
    connectionEpoch,
    health,
    approvalMode,
    changeApprovalMode,
  };
}
