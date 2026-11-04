import { FolderOpen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isTauriRuntime } from "../runtime";
import { resolveWorkspacePath, type LocalFileTarget } from "../localFiles";
import { useSessionFileAccess } from "../sessionFileAccess";
import { RemoteFileBrowser } from "./RemoteFileBrowser";
import "./RemoteFiles.css";

export function OpenPreviewButton(props: {
  workspacePath?: string;
  scope: string;
  onOpen: (target: LocalFileTarget) => void;
  onError: (message: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [visible, setVisible] = useState(false);
  const [path, setPath] = useState("");
  const access = useSessionFileAccess();
  const remote = !isTauriRuntime() || access?.client?.mode === "remote";
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const mounted = useRef(true);
  const current = useRef(props);
  current.current = props;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setVisible(false);
    setPath("");
  }, [props.scope]);
  useEffect(() => {
    const element = dialog.current;
    if (!visible || !element) return;
    element.showModal();
    return () => element.close();
  }, [visible]);
  if (!props.workspacePath || (remote && !access?.sessionId)) return null;
  const close = () => {
    setVisible(false);
    trigger.current?.focus();
  };
  const submit = (value: string) => {
    const resolved = resolveWorkspacePath(value.trim(), props.workspacePath);
    if (!resolved) return;
    close();
    props.onOpen({ path: resolved, line: null, column: null });
  };
  const choose = async () => {
    const scope = props.scope;
    setPending(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        title: "打开项目文件预览",
        defaultPath: props.workspacePath,
        multiple: false,
        directory: false,
      });
      // A native picker can outlive a session switch. Never open in another session.
      if (
        mounted.current &&
        typeof selected === "string" &&
        current.current.scope === scope
      ) {
        setPath(selected);
      }
    } catch (error) {
      if (mounted.current && current.current.scope === scope)
        current.current.onError(`无法选择文件：${String(error)}`);
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="statusbar-icon-button open-preview-trigger"
        data-tooltip="打开项目文件预览"
        title="打开项目文件预览"
        aria-label="打开项目文件预览"
        disabled={pending}
        onClick={() => setVisible(true)}
      >
        <FolderOpen size={16} />
      </button>
      {visible && (
        <dialog
          ref={dialog}
          className="open-preview-dialog"
          aria-label="打开项目文件"
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit(path);
            }}
          >
            <header>
              <strong>打开项目文件</strong>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭文件选择"
                onClick={close}
              >
                <X size={16} />
              </button>
            </header>
            {remote && access && <RemoteFileBrowser access={access} onOpen={submit} />}
            <div className="open-preview-path">
              <span>文件路径</span>
              <div className="open-preview-path-control">
                <input
                  autoFocus={!remote}
                  aria-label="预览文件路径"
                  value={path}
                  placeholder="例如 docs/report.md，或粘贴完整路径"
                  onChange={(event) => setPath(event.target.value)}
                />
                {!remote && <button
                  type="button"
                  className="open-preview-browse"
                  aria-label="浏览文件…"
                  title="浏览文件…"
                  disabled={pending}
                  onClick={() => void choose()}
                >
                  <FolderOpen size={16} />
                </button>}
              </div>
            </div>
            <small title={props.workspacePath}>
              项目：{props.workspacePath}
            </small>
            <footer>
              <button type="submit" disabled={!path.trim()}>
                打开预览
              </button>
            </footer>
          </form>
        </dialog>
      )}
    </>
  );
}
