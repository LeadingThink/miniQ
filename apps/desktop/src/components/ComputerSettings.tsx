import {
  Check,
  ExternalLink,
  LoaderCircle,
  Monitor,
  MousePointer2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "../rpc";
import { errorMessage } from "../errorMessage";
import {
  permissionLabels,
  permissionReady,
  type ComputerPermission,
  type ComputerPermissions,
} from "../computerPermissions";
import "./ComputerSettings.css";

export function ComputerSettings({ client }: { client: RpcClient }) {
  const [status, setStatus] = useState<ComputerPermissions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [requested, setRequested] = useState(false);
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const recheckPending = useRef(false);
  const refresh = useCallback(
    async (permission?: ComputerPermission): Promise<void> => {
      if (permission && client.mode !== "local") return;
      if (inFlight.current) {
        if (!permission) recheckPending.current = true;
        return;
      }
      inFlight.current = true;
      const id = ++epoch.current;
      setPending(true);
      setError(null);
      try {
        const next = await client.call<ComputerPermissions>(
          permission ? "computer.requestPermission" : "computer.permissions",
          permission ? { permission } : undefined,
        );
        if (id !== epoch.current) return;
        setStatus(next);
        if (permission) setRequested(true);
      } catch (cause) {
        if (id === epoch.current) setError(errorMessage(cause));
      } finally {
        if (id === epoch.current) {
          inFlight.current = false;
          setPending(false);
          if (recheckPending.current) {
            recheckPending.current = false;
            void refresh();
          }
        }
      }
    },
    [client],
  );

  useEffect(() => {
    inFlight.current = false;
    recheckPending.current = false;
    setStatus(null);
    setRequested(false);
    void refresh();
    const recheck = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    const unsubscribe = client.onStatus((connected) => {
      if (connected) recheck();
    });
    return () => {
      epoch.current++;
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
      unsubscribe();
    };
  }, [client, refresh]);

  return (
    <section
      className="computer-settings"
      aria-label="电脑控制权限"
      aria-busy={pending}
    >
      <div className="computer-settings-heading">
        <h3>Computer Use</h3>
        <button
          type="button"
          className="icon-button"
          title="重新检查权限"
          aria-label="重新检查权限"
          disabled={pending}
          onClick={() => void refresh()}
        >
          {pending ? (
            <LoaderCircle size={16} className="activity-spinner" />
          ) : (
            <RefreshCw size={16} />
          )}
        </button>
      </div>
      {error && (
        <p role="alert" className="computer-permission-error">
          {error}
        </p>
      )}
      {!status && pending && <p role="status">正在检查执行进程的权限</p>}
      {status && (
        <>
          <dl className="computer-identity">
            <dt>执行平台</dt>
            <dd>
              {status.platform}
              {status.displayServer ? ` / ${status.displayServer}` : ""}
            </dd>
            <dt>执行进程</dt>
            <dd>
              PID {status.processId}
              <code>{status.executable || "路径不可用"}</code>
            </dd>
          </dl>
          {(["screenRecording", "accessibility"] as const).map((permission) => {
            const ready = permissionReady(status[permission]);
            const name =
              permission === "screenRecording" ? "屏幕录制" : "辅助功能";
            return (
              <div className="computer-permission" key={permission}>
                {permission === "screenRecording" ? (
                  <Monitor size={18} />
                ) : (
                  <MousePointer2 size={18} />
                )}
                <div>
                  <strong>{name}</strong>
                  <span
                    className={
                      ready ? "permission-ready" : "permission-attention"
                    }
                  >
                    {ready ? <Check size={13} /> : <ShieldAlert size={13} />}
                    {permissionLabels[status[permission]]}
                  </span>
                </div>
                {status.platform === "macos" && client.mode === "local" && (
                  <button
                    type="button"
                    className="icon-button"
                    title={`打开${name}系统设置`}
                    aria-label={`打开${name}系统设置`}
                    disabled={pending}
                    onClick={() => void refresh(permission)}
                  >
                    <ExternalLink size={16} />
                  </button>
                )}
              </div>
            );
          })}
          {status.platform === "macos" && (
            <p className="computer-permission-note">
              此处显示执行进程的实际权限，不是系统设置开关的副本。系统权限与会话内的操作审批分别生效。
            </p>
          )}
          {status.platform === "macos" &&
            (status.screenRecording === "denied" ||
              status.accessibility === "denied") && (
              <p className="computer-permission-note">
                若系统开关已开启，后台进程可能尚未刷新，或升级后的应用签名与旧授权不匹配。
                仅关闭窗口不会退出后台。未使用开发者证书签名的版本，升级后可能需要重新绑定授权。
              </p>
            )}
          {client.mode === "remote" && (
            <p className="computer-permission-note">
              系统授权需要在这台电脑上由你确认，手机端不能代为授权。
            </p>
          )}
          {status.accessibility === "unsupported" && (
            <p role="status">
              当前桌面环境不支持原生输入。Linux 请使用
              X11；隔离浏览器自动化不受此限制。
            </p>
          )}
          {requested && (
            <p role="status">
              系统设置已打开。完成授权后重新检查；若系统要求重新启动，先结束运行中的任务。
            </p>
          )}
        </>
      )}
    </section>
  );
}
