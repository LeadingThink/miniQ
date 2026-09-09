import { RotateCcw, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import type { ApprovalMode } from "../types";
import { ApprovalModeSelect } from "./ApprovalModeSelect";

type Settings = { mode: ApprovalMode | null; effective: ApprovalMode };
type Props = { client: RpcClient; sessionId: string };

export function SessionPermissionControls(props: Props) {
  return <Controls key={props.sessionId} {...props} />;
}

function Controls({ client, sessionId }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const updating = useRef(false);
  const epoch = useRef(0);
  const load = useCallback(async () => {
    const request = ++epoch.current;
    try {
      const result = await client.call<Settings>("session.approval.get", {
        sessionId,
      });
      if (epoch.current !== request) return;
      setSettings(result);
      setError(null);
    } catch (cause) {
      if (epoch.current === request) setError(errorMessage(cause));
    }
  }, [client, sessionId]);
  useEffect(() => {
    void load();
    const stop = client.onStatus((connected) => {
      if (connected) void load();
    });
    const events = client.onEvent((event) => {
      if (
        event.type === "session_approval_changed" &&
        event.sessionId === sessionId
      )
        void load();
    });
    window.addEventListener("focus", load);
    return () => {
      epoch.current++;
      stop();
      events();
      window.removeEventListener("focus", load);
    };
  }, [client, sessionId, load]);
  const update = async (mode: ApprovalMode | null) => {
    if (updating.current) return;
    updating.current = true;
    setPending(true);
    const request = epoch.current;
    try {
      const result = await client.call<Settings>("session.approval.update", {
        sessionId,
        mode,
      });
      if (epoch.current === request) {
        setSettings(result);
        setError(null);
      }
    } catch (cause) {
      if (epoch.current === request) setError(errorMessage(cause));
    } finally {
      updating.current = false;
      setPending(false);
    }
  };
  return (
    <div
      className="session-permissions"
      aria-label="当前会话权限"
      aria-busy={pending}
    >
      {settings && (
        <ApprovalModeSelect
          mode={settings.effective}
          disabled={pending}
          onChange={(mode) => void update(mode)}
        />
      )}
      {settings?.mode && (
        <button
          type="button"
          className="icon-button"
          disabled={pending}
          title="恢复跟随全局审批设置"
          aria-label="恢复跟随全局审批设置"
          onClick={() => void update(null)}
        >
          <RotateCcw size={14} />
        </button>
      )}
      {!settings && !error && <span role="status">正在读取权限</span>}
      {error && (
        <span role="alert">
          {error}
          <button
            type="button"
            className="icon-button"
            title="刷新会话权限"
            aria-label="刷新会话权限"
            onClick={() => void load()}
          >
            <RefreshCw size={14} />
          </button>
        </span>
      )}
    </div>
  );
}
