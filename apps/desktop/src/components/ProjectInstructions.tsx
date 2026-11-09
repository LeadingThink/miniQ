import { FileText, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";

interface InstructionFileView {
  path: string;
  bytes: number;
  renderedBytes: number;
  truncated: boolean;
}

interface InstructionSettingsView {
  enabled: boolean;
  filenames: string[];
  maxBytes: number;
  projectRootMarkers: string[];
}

interface InstructionsView {
  workspaceId: string;
  workspacePath: string;
  settings: InstructionSettingsView;
  files: InstructionFileView[];
  totalBytes: number;
  preview: string;
  truncated: boolean;
}

/**
 * Review and edit the project instruction file (`AGENTS.md`).
 *
 * The draft is local until saved so a half-edited file never changes what the
 * next turn reads.
 */
export function ProjectInstructions({
  client,
  workspaceId,
}: {
  client: RpcClient;
  workspaceId: string | null;
}) {
  const [view, setView] = useState<InstructionsView | null>(null);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [force, setForce] = useState(false);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setView(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await client.call<InstructionsView>("instructions.get", { workspaceId });
      setView(next);
      setDraft(next.preview);
      setDirty(false);
      setStatus(null);
    } catch (error) {
      setStatus(`读取失败：${errorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!workspaceId) return;
    setSaving(true);
    setStatus(null);
    try {
      await client.call("instructions.update", {
        workspaceId,
        content: draft,
        force,
      });
      await load();
      setStatus("已保存。下一次对话生效。");
    } catch (error) {
      setStatus(`保存失败：${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  if (!workspaceId) {
    return (
      <section className="settings-section">
        <div className="settings-section-title">
          <FileText size={15} />
          <span>项目指令</span>
        </div>
        <p className="settings-section-description">先打开一个项目，再编辑它的 AGENTS.md。</p>
      </section>
    );
  }

  const settings = view?.settings;
  const budgetUsed =
    settings && settings.maxBytes > 0 ? Math.min(100, (view!.totalBytes / settings.maxBytes) * 100) : 0;

  return (
    <section className="settings-section">
      <div className="settings-section-title">
        <FileText size={15} />
        <span>项目指令</span>
        <button type="button" className="settings-inline-action" disabled={loading || saving} onClick={() => void load()}>
          <RefreshCw size={14} />
          <span>重新读取</span>
        </button>
      </div>
      <p className="settings-section-description">
        项目根目录到当前工作目录之间的 AGENTS.md 会自动进入每次对话的上下文。越靠近工作目录的文件越晚读取，冲突时覆盖前面的内容。
      </p>

      <dl className="settings-metrics">
        <div>
          <dt>工作目录</dt>
          <dd title={view?.workspacePath}>{view?.workspacePath ?? "—"}</dd>
        </div>
        <div>
          <dt>已用预算</dt>
          <dd>
            {view?.totalBytes ?? 0} / {settings?.maxBytes ?? 0} 字节
          </dd>
        </div>
        <div>
          <dt>生效文件</dt>
          <dd>{view?.files.length ?? 0} 个</dd>
        </div>
      </dl>

      {settings && !settings.enabled && (
        <p role="status">项目指令读取已关闭，下面的内容不会进入上下文。</p>
      )}
      {budgetUsed >= 100 && <p role="status">已达到字节上限，超出部分会被截断并标注。</p>}

      {view && view.files.length > 0 && (
        <ul className="settings-file-list">
          {view.files.map((file) => (
            <li key={file.path}>
              <code title={file.path}>{file.path}</code>
              <span>
                {file.bytes} 字节{file.truncated ? "（已截断）" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      <label htmlFor="project-instructions">
        编辑 {settings?.filenames?.[1] ?? "AGENTS.md"}
        <textarea
          id="project-instructions"
          className="settings-code-input"
          spellCheck={false}
          rows={18}
          value={draft}
          disabled={loading || saving}
          onChange={(event) => {
            setDraft(event.target.value);
            setDirty(true);
          }}
        />
        <small>保存到项目根目录。清空后保存会删除该文件。</small>
      </label>

      <label htmlFor="instructions-force" className="settings-checkbox">
        <input
          id="instructions-force"
          type="checkbox"
          checked={force}
          onChange={(event) => setForce(event.target.checked)}
        />
        <span>允许保存可能含密钥或内网地址的内容</span>
      </label>

      <div className="settings-actions">
        <button type="button" disabled={loading || saving || !dirty} onClick={() => void save()}>
          {saving ? "正在保存…" : "保存"}
        </button>
      </div>
      {status && <p role="status">{status}</p>}
      {view?.truncated && <p role="status">预览已截断，完整内容请打开文件查看。</p>}
    </section>
  );
}
