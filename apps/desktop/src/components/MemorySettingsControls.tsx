import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";

export interface MemorySettings { recallEnabled: boolean; autoSave: boolean }

export function MemorySettingsControls({ client }: { client: RpcClient }) {
  const [settings, setSettings] = useState<MemorySettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const revision = useRef(0);
  useEffect(() => {
    const request = new AbortController();
    setSettings(null);
    setSaving(false);
    setError(null);
    const load = () => {
      if (pending.current) return;
      const version = ++revision.current;
      void client.call<MemorySettings>("memory.settings", {}, { signal: request.signal })
        .then((value) => { if (!request.signal.aborted && version === revision.current) setSettings(value); })
        .catch((cause) => { if (!request.signal.aborted) setError(errorMessage(cause)); });
    };
    load();
    const unsubscribe = client.onStatus((connected) => { if (connected) load(); });
    return () => { request.abort(); pending.current?.abort(); pending.current = null; unsubscribe(); };
  }, [client]);
  const update = async (value: MemorySettings) => {
    if (pending.current) return;
    const request = new AbortController();
    pending.current = request;
    revision.current += 1;
    setSaving(true);
    setError(null);
    try {
      const result = await client.call<MemorySettings>("memory.configure", value, { signal: request.signal });
      if (!request.signal.aborted) setSettings(result);
    } catch (cause) {
      if (!request.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!request.signal.aborted) { pending.current = null; setSaving(false); }
    }
  };
  return <div aria-label="记忆使用设置">
    <p className="memory-description"><label><input type="checkbox" checked={settings?.recallEnabled ?? false} disabled={!settings || saving}
      onChange={(event) => { if (settings) void update({ ...settings, recallEnabled: event.target.checked }); }} /> 在聊天中使用已保存的记忆</label></p>
    <p className="memory-description"><label><input type="checkbox" checked={settings?.autoSave ?? false} disabled={!settings || saving}
      onChange={(event) => { if (settings) void update({ ...settings, autoSave: event.target.checked }); }} /> 自动记住偏好和项目事实</label></p>
    <p className="memory-description">开启后，正常聊天即可积累记忆，无需专门说“记住”。通用个人偏好保存到全局记忆，可用于当前连接的其他项目；项目偏好和事实只用于所属项目。开启“在聊天中使用已保存的记忆”后，新聊天会自动加载适用的偏好和相关事实。</p>
    <p className="memory-description">自动保存默认关闭，使用会话当前模型整理后续成功对话，会产生模型用量；“每次询问”模式下暂停。临时侧聊不读写记忆。关闭自动保存仍可明确要求记住。</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}
