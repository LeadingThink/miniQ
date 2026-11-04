import { Bot } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";

const DEFAULT_MAX_SUBAGENTS = 8;
const MAX_SUBAGENTS_LIMIT = 32;

interface AgentPreferencesView {
  agentPreferences?: { maxSubagents?: number };
}

export function AdvancedSettings({ client, onClose }: { client: RpcClient; onClose: () => void }) {
  const [maxSubagents, setMaxSubagents] = useState(DEFAULT_MAX_SUBAGENTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void client.call<AgentPreferencesView>("settings.get")
      .then((settings) => {
        const value = settings.agentPreferences?.maxSubagents;
        if (!cancelled && Number.isInteger(value) && value! >= 1 && value! <= MAX_SUBAGENTS_LIMIT) {
          setMaxSubagents(value!);
        }
      })
      .catch((error) => { if (!cancelled) setStatus(`读取设置失败：${errorMessage(error)}`); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [client]);

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      await client.call("settings.update", { agentPreferences: { maxSubagents } });
      onClose();
    } catch (error) {
      setStatus(`保存失败：${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return <section className="settings-section">
    <div className="settings-section-title">
      <Bot size={15} />
      <span>子 Agent</span>
    </div>
    <label htmlFor="max-subagents">
      最多子 Agent 数量
      <input
        id="max-subagents"
        type="number"
        min={1}
        max={MAX_SUBAGENTS_LIMIT}
        step={1}
        value={maxSubagents}
        disabled={loading || saving}
        onChange={(event) => {
          const value = Number(event.target.value);
          if (Number.isInteger(value) && value >= 1 && value <= MAX_SUBAGENTS_LIMIT) setMaxSubagents(value);
        }}
      />
      <small>限制每个会话同时运行的子 Agent 总数。只读任务仍可并行；共享资源和写操作继续顺序执行。</small>
    </label>
    <div className="settings-actions">
      <button type="button" disabled={loading || saving} onClick={() => void save()}>
        {saving ? "正在保存…" : "保存"}
      </button>
    </div>
    {status && <p role="status">{status}</p>}
  </section>;
}