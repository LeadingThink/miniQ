import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Trash2 } from "lucide-react";
import type { RpcClient } from "../rpc";

export interface ApprovalRuleView {
  id: string;
  tool: string;
  binding: { origin: string; pluginMajor?: number | null };
  createdAt: number;
  createdBy: string;
  staleReason?: string | null;
}

const STALE_LABELS: Record<string, string> = {
  origin: "工具来源变化",
  sourceId: "安装来源变化",
  signer: "签名者变化",
  transportFingerprint: "运行方式变化",
  descHash: "工具描述变化",
  pluginMajor: "插件主版本升级",
};

function staleLabel(reason: string): string {
  return STALE_LABELS[reason] ?? reason;
}

/** Lists persistent "always allow" rules and lets the user revoke them. */
export function ApprovalRulesSection(props: { client: RpcClient }) {
  const [rules, setRules] = useState<ApprovalRuleView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    props.client
      .call<{ rules: ApprovalRuleView[] }>("approval.rules.list")
      .then((result) => {
        setRules(result.rules);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [props.client]);

  useEffect(() => {
    refresh();
    return props.client.onEvent((event) => {
      if (event.type === "approval_resolved") refresh();
    });
  }, [props.client, refresh]);

  const revoke = async (rule: ApprovalRuleView) => {
    try {
      await props.client.call("approval.rules.revoke", { ruleId: rule.id });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="approval-rules" style={{ marginTop: 24 }}>
      <div className="page-title" style={{ fontSize: 15 }}>
        <ShieldCheck size={15} /> 总是允许的工具
      </div>
      <div className="page-sub">
        审批时选择“总是允许”的工具会记在这里；插件升级主版本、改描述或换来源后规则自动失效。
      </div>
      {error && <div className="settings-status">{error}</div>}
      {rules.length === 0 ? (
        <div className="plugin-card-meta">暂无规则</div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {rules.map((rule) => (
            <li key={rule.id} className="plugin-card-meta" style={{ display: "flex", gap: 8 }}>
              <span>
                <strong>{rule.tool}</strong> · {rule.binding.origin}
                {rule.staleReason ? `（已失效：${staleLabel(rule.staleReason)}）` : ""}
              </span>
              <span style={{ flex: 1 }} />
              <button className="ghost danger" onClick={() => void revoke(rule)}>
                <Trash2 size={14} />
                撤销
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
