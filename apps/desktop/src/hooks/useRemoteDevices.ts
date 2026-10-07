import { useEffect, useState } from "react";
import type { RemoteCredentials } from "../remoteAccess";
import { deriveRemoteIdentity } from "../remoteCrypto";
import type { RemoteDesktop } from "../remoteDevices";

/** Discovery owns no RpcClient and cannot issue business requests. */
export function useRemoteDevices(credentials: RemoteCredentials) {
  const [devices, setDevices] = useState<RemoteDesktop[]>([]);
  const [scope, setScope] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, refresh] = useState(0);
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const connect = async () => {
      setLoading(true);
      setError(null);
      try {
        const identity = await deriveRemoteIdentity(credentials.apiKey);
        if (disposed) return;
        setScope(identity.roomId);
        const ws = socket = new WebSocket(credentials.relayUrl);
        const current = () => !disposed && socket === ws;
        timeout = setTimeout(() => { if (current()) ws.close(); }, 15_000);
        ws.onopen = () => {
          if (!current()) return;
          ws.send(JSON.stringify({ type: "hello", protocol: 2, role: "mobile", roomId: identity.roomId,
            authToken: identity.authToken, deviceId: credentials.deviceId, deviceName: credentials.deviceName }));
        };
        ws.onmessage = (event) => {
          if (!current()) return;
          try {
            const message = JSON.parse(String(event.data));
            if (message.type === "error") { setError(String(message.message || "无法获取电脑列表")); ws.close(); return; }
            if (message.type !== "devices" || !Array.isArray(message.devices)) return;
            clearTimeout(timeout);
            failures = 0;
            setDevices(message.devices.filter((item: Record<string, unknown>) => item && typeof item.deviceId === "string" && typeof item.deviceName === "string" && typeof item.online === "boolean")
              .map((item: { deviceId: string; deviceName: string; online: boolean }) => ({ id: item.deviceId, name: item.deviceName, online: item.online })));
            setLoading(false);
            setError(null);
          } catch { setError("电脑列表格式无效"); ws.close(); }
        };
        ws.onerror = () => { if (current()) ws.close(); };
        ws.onclose = () => {
          if (!current()) return;
          clearTimeout(timeout);
          setLoading(false);
          setError((previous) => previous ?? "电脑列表连接已断开，正在重试…");
          retry = setTimeout(() => { void connect(); }, Math.min(1000 * 2 ** failures++, 15_000));
        };
      } catch (cause) {
        if (disposed) return;
        setLoading(false);
        setError(cause instanceof Error ? cause.message : "无法获取电脑列表");
      }
    };
    void connect();
    const wake = () => refresh((value) => value + 1);
    const visible = () => { if (document.visibilityState === "visible") wake(); };
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      clearTimeout(retry); clearTimeout(timeout);
      socket?.close();
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [credentials, revision]);
  return { devices, scope, loading, error, refresh: () => refresh((value) => value + 1) };
}
