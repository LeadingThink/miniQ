import { useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import { Switch } from "./ui/Switch";

export interface MemorySettings { recallEnabled: boolean; autoSave: boolean }

export function MemorySettingsControls({ client }: { client: RpcClient }) {
  const id = useId();
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
  return <div className="memory-settings" role="group" aria-label="记忆使用设置">
    <label className="memory-setting" htmlFor={`${id}-recall`}>
      使用记忆
      <Switch
        id={`${id}-recall`}
        label="使用记忆"
        title="在新聊天中使用已保存的偏好和事实"
        checked={settings?.recallEnabled ?? false}
        disabled={!settings || saving}
        onChange={(recallEnabled) => { if (settings) void update({ ...settings, recallEnabled }); }}
      />
    </label>
    <label className="memory-setting" htmlFor={`${id}-auto-save`}>
      自动保存
      <Switch
        id={`${id}-auto-save`}
        label="自动保存"
        title="从聊天中自动保存偏好和事实"
        describedBy={`${id}-usage`}
        checked={settings?.autoSave ?? false}
        disabled={!settings || saving}
        onChange={(autoSave) => { if (settings) void update({ ...settings, autoSave }); }}
      />
      <small id={`${id}-usage`}>消耗模型用量</small>
    </label>
    {error && <p role="alert">{error}</p>}
  </div>;
}
