import { useCallback, useEffect, useState } from "react";
import type { RpcClient } from "../rpc";

interface SkillView {
  name: string;
  description: string;
  version: number;
  origin: string;
  source: "project" | "user" | "bundled";
  enabled: boolean;
}

interface SkillDetailView extends SkillView {
  body: string;
  files: string[];
  skillDir?: string;
}

const SOURCE_LABEL: Record<SkillView["source"], string> = {
  project: "项目",
  user: "我的",
  bundled: "内置",
};

export function SkillsPanel(props: { client: RpcClient; workspaceId: string | null }) {
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [detail, setDetail] = useState<SkillDetailView | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const scope = props.workspaceId ? { workspaceId: props.workspaceId } : {};

  const refresh = useCallback(async () => {
    try {
      const res = await props.client.call<{ skills: SkillView[] }>("skill.list", scope);
      setSkills(res.skills);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.client, props.workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (skill: SkillView) => {
    await props.client.call("skill.setEnabled", {
      name: skill.name,
      enabled: !skill.enabled,
    });
    await refresh();
  };

  const open = async (skill: SkillView) => {
    const res = await props.client.call<SkillDetailView>("skill.read", {
      name: skill.name,
      ...scope,
    });
    setDetail(res);
  };

  const remove = async (skill: SkillView) => {
    if (!window.confirm(`删除技能"${skill.name}"?`)) return;
    try {
      await props.client.call("skill.delete", { name: skill.name, ...scope });
      setDetail(null);
      await refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="page">
      <div className="page-inner wide">
        <div className="page-header">
          <div className="page-title">技能</div>
          <div className="page-sub">
            可复用的工作流。启用的技能会在任务中自动使用;完成任务后可通过「保存为技能」蒸馏新技能。
          </div>
        </div>
        {status && <div className="settings-status">{status}</div>}

        {detail ? (
          <div className="skill-detail">
            <div className="card-head">
              <button className="ghost" onClick={() => setDetail(null)}>
                ← 返回
              </button>
              <span className="tool-name">{detail.name}</span>
              <span className="badge">{SOURCE_LABEL[detail.source]}</span>
              <span className="badge">v{detail.version}</span>
            </div>
            <div style={{ color: "var(--text-dim)", fontSize: 13 }}>{detail.description}</div>
            {detail.files.length > 0 && (
              <div className="settings-status">附带文件: {detail.files.join(", ")}</div>
            )}
            <pre className="skill-body">{detail.body}</pre>
            {detail.source === "user" && (
              <button
                className="danger"
                onClick={() => remove(detail)}
                style={{ alignSelf: "flex-start" }}
              >
                删除技能
              </button>
            )}
          </div>
        ) : skills.length === 0 ? (
          <div className="schedule-empty">
            <div className="schedule-empty-icon">✦</div>
            <div className="schedule-empty-title">还没有技能</div>
            <div className="schedule-empty-sub">
              完成一次任务后,点右上角「保存为技能」,agent 就会学会这个工作流
            </div>
          </div>
        ) : (
          <div className="card-grid">
            {skills.map((skill) => (
              <div
                key={skill.name}
                className={`asset-card clickable ${skill.enabled ? "" : "off"}`}
                onClick={() => void open(skill)}
              >
                <div className="asset-card-head">
                  <div className="asset-icon">{skill.name.slice(0, 1).toUpperCase()}</div>
                  <div className="asset-name" title={skill.name}>
                    {skill.name}
                  </div>
                  <div
                    className={`switch ${skill.enabled ? "on" : ""}`}
                    title={skill.enabled ? "点击禁用" : "点击启用"}
                    onClick={(e) => {
                      e.stopPropagation();
                      void toggle(skill);
                    }}
                  >
                    <div className="switch-knob" />
                  </div>
                </div>
                <div className="asset-desc">{skill.description || "(无描述)"}</div>
                <div className="asset-meta">
                  <span className="badge">{SOURCE_LABEL[skill.source]}</span>
                  <span className="badge">v{skill.version}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
