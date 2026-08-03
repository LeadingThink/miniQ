import { useCallback, useEffect, useRef, useState } from "react";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { errorMessage } from "../errorMessage";
import type { ConnectionInfo, RpcClient } from "../rpc";
import { isTauriRuntime } from "../runtime";

const STARTUP_CHECK_DELAY_MS = 10_000;
const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1_000;
const FOCUS_CHECK_INTERVAL_MS = 60_000;

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "error";

export interface AppUpdaterState {
  phase: UpdatePhase;
  version: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
}

const INITIAL_STATE: AppUpdaterState = {
  phase: "idle",
  version: null,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
};

export function shouldCheckForUpdate(lastCheckedAt: number, now: number): boolean {
  return now - lastCheckedAt >= FOCUS_CHECK_INTERVAL_MS;
}

export function applyDownloadEvent(
  state: AppUpdaterState,
  event: DownloadEvent,
): AppUpdaterState {
  switch (event.event) {
    case "Started":
      return {
        ...state,
        phase: "downloading",
        downloadedBytes: 0,
        totalBytes: event.data.contentLength ?? null,
      };
    case "Progress":
      return {
        ...state,
        downloadedBytes: state.downloadedBytes + event.data.chunkLength,
      };
    case "Finished":
      return {
        ...state,
        downloadedBytes: state.totalBytes ?? state.downloadedBytes,
      };
  }
}

async function reconnectDaemon(client: RpcClient): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const info = await invoke<ConnectionInfo>("daemon_connection");
  await client.connect(info);
}

export function useAppUpdater(client: RpcClient, onError: (message: string) => void) {
  const [state, setState] = useState<AppUpdaterState>(INITIAL_STATE);
  const updateRef = useRef<Update | null>(null);
  const checkRef = useRef<Promise<void> | null>(null);
  const installRef = useRef(false);
  const lastCheckedAtRef = useRef(Date.now());
  const supported = isTauriRuntime() && !import.meta.env.DEV;

  const runCheck = useCallback(
    async (silent: boolean) => {
      if (!supported) return;
      if (installRef.current) return;
      if (checkRef.current) return checkRef.current;
      const task = (async () => {
        lastCheckedAtRef.current = Date.now();
        if (!silent) setState((current) => ({ ...current, phase: "checking", error: null }));
        try {
          const { check } = await import("@tauri-apps/plugin-updater");
          const update = await check({ timeout: 30_000 });
          if (!update) {
            if (updateRef.current) await updateRef.current.close();
            updateRef.current = null;
            setState(INITIAL_STATE);
            return;
          }
          if (updateRef.current) await updateRef.current.close();
          updateRef.current = update;
          setState({
            phase: "available",
            version: update.version,
            downloadedBytes: 0,
            totalBytes: null,
            error: null,
          });
        } catch (error) {
          const message = errorMessage(error);
          setState((current) => ({ ...current, phase: "error", error: message }));
          if (!silent) onError(`检查更新失败：${message}`);
        }
      })();
      checkRef.current = task;
      try {
        await task;
      } finally {
        checkRef.current = null;
      }
    },
    [onError, supported],
  );

  useEffect(() => {
    if (!supported) return;
    const startupTimer = window.setTimeout(
      () => void runCheck(true),
      STARTUP_CHECK_DELAY_MS,
    );
    const interval = window.setInterval(
      () => void runCheck(true),
      UPDATE_CHECK_INTERVAL_MS,
    );
    const checkWhenVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (!shouldCheckForUpdate(lastCheckedAtRef.current, Date.now())) return;
      void runCheck(true);
    };
    window.addEventListener("focus", checkWhenVisible);
    document.addEventListener("visibilitychange", checkWhenVisible);
    return () => {
      window.clearTimeout(startupTimer);
      window.clearInterval(interval);
      window.removeEventListener("focus", checkWhenVisible);
      document.removeEventListener("visibilitychange", checkWhenVisible);
    };
  }, [runCheck, supported]);

  useEffect(
    () => () => {
      if (updateRef.current) void updateRef.current.close();
    },
    [],
  );

  const install = useCallback(async () => {
    const update = updateRef.current;
    if (!update || state.phase !== "available") return;
    let daemonStopped = false;
    installRef.current = true;
    try {
      setState((current) => ({ ...current, phase: "downloading", error: null }));
      await update.download((event) => setState((current) => applyDownloadEvent(current, event)));
      setState((current) => ({ ...current, phase: "installing" }));
      await client.call("daemon.shutdown");
      daemonStopped = true;
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("wait_for_daemon_exit");
      await update.install();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      const message = errorMessage(error);
      if (daemonStopped) {
        try {
          await reconnectDaemon(client);
        } catch {
          // The update error remains the primary actionable failure.
        }
      }
      setState((current) => ({ ...current, phase: "error", error: message }));
      onError(`更新失败：${message}`);
    } finally {
      installRef.current = false;
    }
  }, [client, onError, state.phase]);

  return {
    state,
    supported,
    checkNow: () => runCheck(false),
    install,
  };
}
