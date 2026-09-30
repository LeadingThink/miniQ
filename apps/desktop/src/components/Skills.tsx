import { useCallback, useEffect, useState } from "react";
import { Sparkles, Upload } from "lucide-react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import { isTauriRuntime } from "../runtime";
import { RemotePathDialog } from "./RemotePathDialog";
import { EmptyState } from "./ui/EmptyState";
import { Switch } from "./ui/Switch";
import { showUndoToast, useToast } from "./ui/Toast";

interface SkillView {
  name: string;
  description: string;
  version: number;
  origin: string;
  source: "project" | "user" | "bundled" | "plugin";
  enabled: boolean;
  dependencies?: { command: string; available: boolean }[];
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
  plugin: "插件",
};

function SkillDetail(props: {
  detail: SkillDetailView;
  onBack: () => void;
  onRemove: (skill: SkillView) => void;
}) {
  const { detail } = props;
  return (
    <div className="skill-detail">
      <div className="card-head">
        <button className="ghost" onClick={props.onBack}>
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
          onClick={() => props.onRemove(detail)}
          style={{ alignSelf: "flex-start" }}
        >
          删除技能
        </button>
      )}
    </div>
  );
}

function SkillGrid(props: {
  skills: SkillView[];
  onOpen: (skill: SkillView) => void;
  onToggle: (skill: SkillView) => void;
}) {
  return (
    <div className="card-grid">
      {props.skills.map((skill) => (
        <div
          key={skill.name}
          className={`asset-card clickable ${skill.enabled ? "" : "off"}`}
          onClick={() => props.onOpen(skill)}
        >
          <div className="asset-card-head">
            <div className="asset-icon">{skill.name.slice(0, 1).toUpperCase()}</div>
            <div className="asset-name" title={skill.name}>
              {skill.name}
            </div>
            <Switch
              checked={skill.enabled}
              label={`${skill.enabled ? "停用" : "启用"}${skill.name}`}
              title={skill.enabled ? "点击禁用" : "点击启用"}
              onChange={() => props.onToggle(skill)}
            />
          </div>
          <div className="asset-desc">{skill.description || "(无描述)"}</div>
          <div className="asset-meta">
            <span className="badge">{SOURCE_LABEL[skill.source]}</span>
            <span className="badge">v{skill.version}</span>
            {(skill.dependencies ?? []).map((dependency) => (
              <span className="badge" key={dependency.command} title="运行时会检查该依赖是否在 PATH 中">
                依赖 {dependency.command} {dependency.available ? "✓" : "缺少"}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptySkills() {
  return (
    <EmptyState
      icon={<Sparkles size={28} />}
      title="还没有技能"
      description="完成一次任务后，点右上角“保存为技能”，agent 就会学会这个工作流"
    />
  );
}

export function SkillsPanel(props: { client: RpcClient; workspaceId: string | null }) {
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [detail, setDetail] = useState<SkillDetailView | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [remotePicker, setRemotePicker] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const toast = useToast();
  const scope = props.workspaceId ? { workspaceId: props.workspaceId } : {};

  const refresh = useCallback(async () => {
    try {
      const res = await props.client.call<{ skills: SkillView[] }>("skill.list", scope);
      setSkills(res.skills);
    } catch (error) {
      setStatus(errorMessage(error));
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
    const result = await props.client.call<SkillDetailView>("skill.read", {
      name: skill.name,
      ...scope,
    });
    setDetail(result);
  };

  const unhide = (name: string) =>
    setHidden((current) => {
      const next = new Set(current);
      next.delete(name);
      return next;
    });

  const remove = async (skill: SkillView) => {
    const deleteScope = scope;
    setHidden((current) => new Set(current).add(skill.name));
    setDetail(null);
    showUndoToast(toast, {
      message: `已删除技能“${skill.name}”`,
      onUndo: () => unhide(skill.name),
      onCommit: () => {
        void (async () => {
          try {
            await props.client.call("skill.delete", { name: skill.name, ...deleteScope });
            await refresh();
          } catch (error) {
            setStatus(errorMessage(error));
          } finally {
            unhide(skill.name);
          }
        })();
      },
    });
  };
  const visibleSkills = skills.filter((skill) => !hidden.has(skill.name));

  const importPackage = async () => {
    if (props.client.sshHost) {
      setRemotePicker(true);
      return;
    }
    let path: string | null = null;
    try {
      if (isTauriRuntime()) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({ directory: true, multiple: false, title: "选择技能包目录" });
        path = typeof selected === "string" ? selected : null;
      } else {
        path = window.prompt("技能包目录（绝对路径）:");
      }
    } catch (error) {
      setStatus(errorMessage(error));
      return;
    }
    if (!path) return;
    try {
      const result = await props.client.call<{ skills: SkillView[]; imported: SkillView[] }>("skill.import", { path });
      setSkills(result.skills);
      setStatus(`已导入 ${result.imported.length} 个技能，可在列表中查看版本`);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  };

  return (
    <div className="page">
      {remotePicker && props.client.sshHost && <RemotePathDialog
        host={props.client.sshHost}
        purpose="skill"
        onClose={() => setRemotePicker(false)}
        onSubmit={async (path) => {
          const result = await props.client.call<{ skills: SkillView[]; imported: SkillView[] }>("skill.import", { path });
          setSkills(result.skills);
          setStatus(`已导入 ${result.imported.length} 个远程技能`);
        }}
      />}
      <div className="page-inner wide">
        <div className="page-header skills-page-header">
          <div>
            <div className="page-title">技能</div>
            <div className="page-sub">
              可复用的工作流。启用的技能会在任务中自动使用;完成任务后可通过「保存为技能」蒸馏新技能。
            </div>
          </div>
          <button onClick={() => void importPackage()} title="导入或更新包含一个或多个 SKILL.md 的目录">
            <Upload size={15} />
            导入技能包
          </button>
        </div>
        {status && <div className="settings-status">{status}</div>}
        {detail ? (
          <SkillDetail detail={detail} onBack={() => setDetail(null)} onRemove={remove} />
        ) : visibleSkills.length === 0 ? (
          <EmptySkills />
        ) : (
          <SkillGrid skills={visibleSkills} onOpen={(skill) => void open(skill)} onToggle={toggle} />
        )}
      </div>
    </div>
  );
}
