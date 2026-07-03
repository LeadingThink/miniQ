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

export function SkillsPanel(props: {
  client: RpcClient;
  workspaceId: string | null;
  onClose: () => void;
}) {
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
    if (!window.confirm(`Delete skill "${skill.name}"?`)) return;
    try {
      await props.client.call("skill.delete", { name: skill.name, ...scope });
      setDetail(null);
      await refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="settings-overlay" onClick={props.onClose}>
      <div
        className="settings-panel skills-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Skills</h2>
        {status && <div className="error-banner">{status}</div>}
        {detail ? (
          <div className="skill-detail">
            <div className="card-head">
              <span className="tool-name">{detail.name}</span>
              <span className="badge">{detail.source}</span>
              <span className="badge">v{detail.version}</span>
              <span style={{ flex: 1 }} />
              <button className="secondary" onClick={() => setDetail(null)}>
                Back
              </button>
            </div>
            <div style={{ margin: "8px 0", color: "var(--text-dim)" }}>
              {detail.description}
            </div>
            {detail.files.length > 0 && (
              <div className="settings-status">files: {detail.files.join(", ")}</div>
            )}
            <pre className="skill-body">{detail.body}</pre>
            {detail.source === "user" && (
              <button
                className="danger"
                onClick={() => remove(detail)}
                style={{ alignSelf: "flex-start" }}
              >
                Delete skill
              </button>
            )}
          </div>
        ) : (
          <div className="skill-list">
            {skills.length === 0 && (
              <div className="settings-status">No skills discovered.</div>
            )}
            {skills.map((skill) => (
              <div key={skill.name} className="skill-row">
                <div className="skill-row-main" onClick={() => open(skill)}>
                  <span className="tool-name">{skill.name}</span>
                  <span className="badge">{skill.source}</span>
                  <div className="sub">{skill.description}</div>
                </div>
                <button
                  className={skill.enabled ? "secondary" : ""}
                  onClick={() => toggle(skill)}
                >
                  {skill.enabled ? "Disable" : "Enable"}
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="approval-actions">
          <button className="secondary" onClick={props.onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
