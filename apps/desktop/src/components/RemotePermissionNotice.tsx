import { useEffect, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import { notifyRemotePermissionRaise } from "../taskNotifications";
import type { ApprovalMode } from "../types";

export const APPROVAL_MODE_NAMES: Record<ApprovalMode, string> = {
  alwaysAsk: "请求批准",
  auto: "替我审批",
  fullAccess: "完全访问",
};

type Raise = {
  sessionId: string;
  device: string;
  mode: ApprovalMode;
  previous: ApprovalMode;
};

/**
 * Shown on the host when a remote device raised a session's permission level
 * (D16). The owner can revert it with one click; the change stays scoped to
 * that session either way.
 */
export function RemotePermissionNotice({ client }: { client: RpcClient }) {
  const [raises, setRaises] = useState<Raise[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (client.mode === "remote") return;
    return client.onEvent((event) => {
      if (event.type !== "session_approval_changed") return;
      const { sessionId, mode, actor, previous, raised } = event;
      if (!raised || !mode || !previous || !actor?.startsWith("remote")) {
        // A later local change supersedes any pending notice for the session.
        if (!actor) setRaises((all) => all.filter((r) => r.sessionId !== sessionId));
        return;
      }
      const device = actor.slice("remote:".length) || "未知设备";
      setRaises((all) => [
        ...all.filter((r) => r.sessionId !== sessionId),
        { sessionId, device, mode, previous },
      ]);
      void notifyRemotePermissionRaise(device, APPROVAL_MODE_NAMES[mode]);
    });
  }, [client]);
  if (raises.length === 0) return null;
  const dismiss = (sessionId: string) =>
    setRaises((all) => all.filter((r) => r.sessionId !== sessionId));
  const revert = async (raise: Raise) => {
    try {
      await client.call("session.approval.update", {
        sessionId: raise.sessionId,
        mode: raise.previous,
      });
      dismiss(raise.sessionId);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  return (
    <>
      {raises.map((raise) => (
        <div key={raise.sessionId} className="error-banner" role="alert">
          <span style={{ flex: 1 }}>
            远程设备 {raise.device} 将一个会话的权限从「
            {APPROVAL_MODE_NAMES[raise.previous]}」提升为「
            {APPROVAL_MODE_NAMES[raise.mode]}」（仅影响该会话）。
            {error && ` 撤回失败：${error}`}
          </span>
          <button type="button" className="ghost" onClick={() => void revert(raise)}>
            撤回
          </button>
          <button
            type="button"
            className="banner-close"
            aria-label="关闭远程权限提示"
            onClick={() => dismiss(raise.sessionId)}
          >
            ✕
          </button>
        </div>
      ))}
    </>
  );
}
