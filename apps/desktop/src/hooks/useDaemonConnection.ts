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
}

async function connectWithRetry(options: ConnectAttemptOptions): Promise<void> {
  const maxAttempts = 10;
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
      options.onHealth(health);
      const settings = await options.client.call<{ approvalMode?: ApprovalMode }>(
        "settings.get",
      );
      if (settings.approvalMode) options.onApprovalMode(settings.approvalMode);
      await options.refreshWorkspaces();
      await options.refreshSessions();
      options.onError(null);
      return;
    } catch (error) {
      if (options.isDisposed()) return;
      if (attempt >= maxAttempts) {
        options.onError(errorMessage(error));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }
}

export function useDaemonConnection(options: ConnectionOptions) {
  const [connected, setConnected] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("auto");
  const { client, refreshWorkspaces, refreshSessions, onError } = options;

  useEffect(() => {
    let disposed = false;
    void connectWithRetry({
      client,
      refreshWorkspaces,
      refreshSessions,
      onError,
      isDisposed: () => disposed,
      onConnected: setConnected,
      onHealth: setHealth,
      onApprovalMode: setApprovalMode,
    });
    const offStatus = client.onStatus(setConnected);
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

  return { connected, health, approvalMode, changeApprovalMode };
}
