import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";

export type SettingsLoadError = { path: string; error: string; backupPath?: string };
export type SettingsStatus = { loadError?: SettingsLoadError; backupAvailable?: boolean };

/**
 * Red banner shown while the daemon runs on default settings because
 * `settings.json` could not be parsed (plan §4.6). The original file is never
 * overwritten; the owner can locate it or restore the last good backup.
 */
export function SettingsLoadErrorBanner({ client }: { client: RpcClient }) {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    Promise.resolve()
      .then(() => client.call<SettingsStatus>("settings.status"))
      .then(setStatus)
      .catch(() => {});
  }, [client]);

  useEffect(() => {
    refresh();
    // Partial clients (tests, embedded hosts) may lack status notifications.
    const offStatus =
      typeof client.onStatus === "function"
        ? client.onStatus((connected) => {
            if (connected) refresh();
          })
        : () => {};
    const offEvent = client.onEvent((event) => {
      if (event.type !== "settings_load_failed") return;
      const { path, error, backupPath } = event;
      setStatus((current) => ({ ...current, loadError: { path, error, backupPath } }));
    });
    return () => {
      offStatus();
      offEvent();
    };
  }, [client, refresh]);

  const failure = status?.loadError;
  if (!failure) return null;
  const remote = client.mode === "remote";

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(failure.path);
      setMessage("已复制文件路径");
    } catch (cause) {
      setMessage(`复制失败：${errorMessage(cause)}`);
    }
  };
  const restore = async () => {
    setBusy(true);
    try {
      const next = await client.call<SettingsStatus>("settings.restoreBackup");
      setStatus(next);
      setMessage(null);
    } catch (cause) {
      setMessage(`恢复失败：${errorMessage(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="error-banner settings-load-error" role="alert">
      <span style={{ flex: 1 }}>
        配置文件损坏，已按默认配置启动，原文件未被覆盖。
        <br />
        文件位置：<code>{failure.path}</code>
        {failure.backupPath && (
          <>
            {"；损坏副本："}
            <code>{failure.backupPath}</code>
          </>
        )}
        <br />
        错误：{failure.error}
        {message && ` · ${message}`}
      </span>
      <button type="button" className="ghost" onClick={() => void copyPath()}>
        复制文件路径
      </button>
      {!remote && status?.backupAvailable && (
        <button type="button" className="ghost" disabled={busy} onClick={() => void restore()}>
          恢复备份
        </button>
      )}
    </div>
  );
}
