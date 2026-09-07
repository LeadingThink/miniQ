import { useEffect, useRef, useState } from "react";
import { Folder, FolderOpen, Plus, Save, Star, Trash2, X } from "lucide-react";
import type { Session, Workspace } from "../types";
import { errorMessage } from "../errorMessage";
import { isTauriRuntime } from "../runtime";
import { isSessionRunning } from "../sessionStatus";
import "./ProjectDirectories.css";

interface Props {
  readOnly?: boolean;
  workspace: Workspace;
  sessions: Session[];
  onSave: (paths: string[]) => Promise<void>;
  onClose: () => void;
}

export function ProjectDirectories({ workspace, sessions, onSave, onClose, readOnly = false }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [paths, setPaths] = useState(() => [workspace.path, ...workspace.additionalPaths]);
  const [path, setPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = sessions.some((session) => isSessionRunning(session.status));
  const disabled = saving || active || readOnly;
  const usedPaths = new Set(sessions.map((session) => session.workingDirectory));
  const changed = JSON.stringify(paths) !== JSON.stringify([workspace.path, ...workspace.additionalPaths]);

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  function addPath(candidate: string) {
    const value = candidate.trim();
    if (!value) return;
    if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)) {
      setError("请输入桌面电脑上的绝对路径");
      return;
    }
    if (paths.includes(value)) { setError("该目录已添加"); return; }
    setPaths((current) => [...current, value]);
    setPath("");
    setError(null);
  }

  async function browse() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: true, title: "添加项目目录" });
      if (selected) {
        const directories = Array.isArray(selected) ? selected : [selected];
        setPaths((current) => [...new Set([...current, ...directories])]);
        setError(null);
      }
    } catch (cause) { setError(errorMessage(cause)); }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try { await onSave(paths); onClose(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }

  return (
    <dialog ref={dialog} className="project-directories" aria-labelledby="project-directories-title"
      onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
      <header>
        <div><h2 id="project-directories-title">项目目录</h2><span>{workspace.name}{readOnly ? " · 只读" : ""}</span></div>
        <button type="button" disabled={saving} title="关闭" aria-label="关闭" onClick={onClose}><X size={18} /></button>
      </header>
      <ol className="project-root-list">
        {paths.map((directory, index) => (
          <li key={directory}>
            <Folder size={17} />
            <div className="project-root-path"><span>{directory}</span><small>{index === 0 ? "主目录" : "附加目录"}{usedPaths.has(directory) ? " · 会话使用中" : ""}</small></div>
            <button type="button" disabled={disabled || index === 0} title="设为主目录" aria-label={`设为主目录 ${directory}`}
              onClick={() => setPaths([directory, ...paths.filter((item) => item !== directory)])}><Star size={16} fill={index === 0 ? "currentColor" : "none"} /></button>
            <button type="button" disabled={disabled || index === 0 || usedPaths.has(directory)} title="移除目录" aria-label={`移除目录 ${directory}`}
              onClick={() => setPaths(paths.filter((item) => item !== directory))}><Trash2 size={16} /></button>
          </li>
        ))}
      </ol>
      {!readOnly && <form className="project-root-add" onSubmit={(event) => { event.preventDefault(); if (!disabled) addPath(path); }}>
        <input aria-label="目录绝对路径" placeholder="目录绝对路径" value={path} disabled={disabled} onChange={(event) => setPath(event.target.value)} />
        {isTauriRuntime() && <button type="button" disabled={disabled} title="选择文件夹" aria-label="选择文件夹" onClick={() => void browse()}><FolderOpen size={17} /></button>}
        <button type="submit" disabled={disabled || !path.trim()} title="添加目录" aria-label="添加目录"><Plus size={18} /></button>
      </form>}
      {active && <div role="status">项目有任务正在运行，目录暂不可修改</div>}
      {error && <div className="project-roots-error" role="alert">{error}</div>}
      {!readOnly && <footer><button type="button" className="project-roots-save" disabled={disabled || !changed || !!path.trim()} onClick={() => void save()}><Save size={16} />{saving ? "保存中" : "保存"}</button></footer>}
    </dialog>
  );
}
