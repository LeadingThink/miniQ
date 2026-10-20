import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import { isTauriRuntime } from "../runtime";
import { UPDATE_PERIODIC_CHECK_MS, UPDATE_RECHECK_INTERVAL_MS } from "../updatePolicy";

const STARTUP_CHECK_DELAY_MS = 10_000;

export type UpdatePhase =
  | "idle"
  | "up-to-date"
  | "checking"
  | "unavailable"
  | "available"
  | "stopping"
  | "downloading"
  | "installing"
  | "error";

export type UpdateBusyReason = "active-task" | "queued-messages";

export interface AppUpdaterState {
  phase: UpdatePhase;
  version: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
  /** Set when installation was deferred because the daemon is still doing work. */
  busyReason: UpdateBusyReason | null;
  /** Release notes of the available version, one entry per line of `Update.body`. */
  releaseNotes: string[];
}

/** Turn the updater's free-text body into display lines without list markers. */
export function parseReleaseNotes(body: string | null | undefined): string[] {
  return (body ?? "").split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
}

const INITIAL_STATE: AppUpdaterState = {
  phase: "idle",
  version: null,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
  busyReason: null,
  releaseNotes: [],
};

export function shouldCheckForUpdate(lastCheckedAt: number, now: number): boolean {
  return now - lastCheckedAt >= UPDATE_RECHECK_INTERVAL_MS;
}

export function isUnsupportedPlatformUpdateError(message: string): boolean {
  return (
    message.includes("fallback platforms") &&
    message.includes("were found in the response")
  );
}

/** Convert the daemon's intentional busy response into a user decision. */
export function updateBusyReason(message: string): UpdateBusyReason | null {
  if (message.includes("queued messages") || message.includes("排队消息")) return "queued-messages";
  if (message.includes("active tasks or requests") || message.includes("任务执行中")) return "active-task";
  return null;
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

export function useAppUpdater(
  client: RpcClient,
  onError: (message: string) => void,
  pauseTransport?: (paused: boolean) => void,
  stopActiveTask?: (expectedSessionId?: string | null) => Promise<void>,
  isTaskActive?: () => boolean,
  getCurrentSessionId?: () => string | null,
) {
  const [state, setState] = useState<AppUpdaterState>(INITIAL_STATE);
  const updateRef = useRef<Update | null>(null);
  const checkRef = useRef<Promise<void> | null>(null);
  const explicitCheckRef = useRef(false);
  const installRef = useRef(false);
  const stoppingRef = useRef(false);
  const stopConfirmedRef = useRef(false);
  const busySessionIdRef = useRef<string | null>(null);
  const lastCheckedAtRef = useRef(Date.now());
  const supported = isTauriRuntime() && !client.sshHost && !import.meta.env.DEV;

  const runCheck = useCallback(
    async (silent: boolean) => {
      if (!supported) return;
      if (installRef.current) return;
      if (!silent) {
        explicitCheckRef.current = true;
        setState((current) => ({ ...current, phase: "checking", error: null }));
      }
      if (checkRef.current) return checkRef.current;
      const task = (async () => {
        lastCheckedAtRef.current = Date.now();
        try {
          const { check } = await import("@tauri-apps/plugin-updater");
          const update = await check({ timeout: 30_000 });
          if (!update) {
            if (updateRef.current) await updateRef.current.close();
            updateRef.current = null;
            if (explicitCheckRef.current) {
              const { getVersion } = await import("@tauri-apps/api/app");
              const version = await getVersion().catch(() => null);
              setState({ ...INITIAL_STATE, phase: "up-to-date", version });
            } else {
              setState((current) => current.phase === "up-to-date" ? current : INITIAL_STATE);
            }
            return;
          }
          if (updateRef.current) await updateRef.current.close();
          updateRef.current = update;
          const busyReason = isTaskActive?.() ? "active-task" : null;
          busySessionIdRef.current = busyReason ? (getCurrentSessionId?.() ?? null) : null;
          setState({
            phase: "available",
            version: update.version,
            downloadedBytes: 0,
            totalBytes: null,
            error: null,
            busyReason,
            releaseNotes: parseReleaseNotes(update.body),
          });
        } catch (error) {
          const message = errorMessage(error);
          if (isUnsupportedPlatformUpdateError(message)) {
            setState({ ...INITIAL_STATE, phase: "unavailable" });
            return;
          }
          setState((current) => ({ ...current, phase: "error", error: message }));
          if (explicitCheckRef.current) onError(`检查更新失败：${message}`);
        }
      })();
      checkRef.current = task;
      try {
        await task;
      } finally {
        checkRef.current = null;
        explicitCheckRef.current = false;
      }
    },
    [getCurrentSessionId, isTaskActive, onError, supported],
  );

  useEffect(() => {
    if (!supported) return;
    const startupTimer = window.setTimeout(
      () => void runCheck(true),
      STARTUP_CHECK_DELAY_MS,
    );
    const interval = window.setInterval(
      () => void runCheck(true),
      UPDATE_PERIODIC_CHECK_MS,
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
    if (!update || !["available", "stopping"].includes(state.phase) || installRef.current) return;
    if (!stopConfirmedRef.current && isTaskActive?.()) {
      setState((current) => ({ ...current, phase: "available", busyReason: "active-task", error: null }));
      return;
    }
    if (client.sshHost) {
      onError("请先在设置中切换到本机，再安装桌面更新。远端任务会继续运行。");
      return;
    }
    let prepared = false;
    let installerStarted = false;
    installRef.current = true;
    try {
      setState((current) => ({ ...current, phase: "downloading", error: null, busyReason: null }));
      await update.download((event) => setState((current) => applyDownloadEvent(current, event)));
      // Dispose reconnect effects before the native shutdown request can close the socket.
      flushSync(() => {
        pauseTransport?.(true);
        setState((current) => ({ ...current, phase: "installing" }));
      });
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("prepare_daemon_update");
      prepared = true;
      await client.call("daemon.shutdownIfIdle").catch((error: unknown) => {
        // RpcClient includes the backend SessionBusy code in the Error message.
        const message = errorMessage(error);
        if (message.endsWith("(code -32003)")) {
          throw new Error(message.includes("miniQ has queued messages")
            ? "还有排队消息，请等待任务完成后更新。"
            : "任务执行中，请等待任务完成后更新。");
        }
        throw error;
      });
      await invoke("wait_for_daemon_exit");
      await update.install();
      installerStarted = true;
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      const message = errorMessage(error);
      if (installerStarted) {
        onError(`安装器已启动，请完成安装后重新打开 miniQ：${message}`);
        return;
      }
      if (prepared) {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("cancel_daemon_update");
        } catch (resumeError) {
          onError(`更新失败：${message}；恢复后台连接失败：${errorMessage(resumeError)}`);
          return;
        }
      }
      const busyReason = updateBusyReason(message);
      if (busyReason) {
        busySessionIdRef.current = getCurrentSessionId?.() ?? null;
        setState((current) => ({ ...current, phase: "available", busyReason, error: null }));
        pauseTransport?.(false);
        return;
      }
      setState((current) => ({ ...current, phase: "error", error: message, busyReason: null }));
      pauseTransport?.(false);
      onError(`更新失败：${message}`);
    } finally {
      installRef.current = false;
    }
  }, [client, isTaskActive, onError, state.phase, pauseTransport]);

  const deferTaskPrompt = useCallback(() => {
    setState((current) => ({ ...current, phase: "available", busyReason: null, error: null }));
  }, []);

  const stopTaskAndInstall = useCallback(async () => {
    if (!stopActiveTask || !updateRef.current || !state.busyReason || stoppingRef.current || installRef.current) return;
    stoppingRef.current = true;
    stopConfirmedRef.current = true;
    setState((current) => ({ ...current, phase: "stopping", error: null }));
    try {
      await stopActiveTask(busySessionIdRef.current);
      await install();
    } catch (error) {
      const message = errorMessage(error);
      setState((current) => ({ ...current, phase: "error", busyReason: null, error: message }));
      onError(`停止任务失败：${message}`);
    } finally {
      stopConfirmedRef.current = false;
      stoppingRef.current = false;
    }
  }, [getCurrentSessionId, install, onError, state.busyReason, stopActiveTask]);

  return {
    state,
    supported,
    checkNow: () => runCheck(false),
    install,
    deferTaskPrompt,
    stopTaskAndInstall,
  };
}
