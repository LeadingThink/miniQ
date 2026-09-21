import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import "./ProjectDirectories.css";
import "./RemotePathDialog.css";

export function RemotePathDialog(props: {
  host: string;
  purpose: "project" | "attachment" | "plugin";
  onSubmit: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [path, setPath] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  const title =
    props.purpose === "project"
      ? "打开远程项目"
      : props.purpose === "plugin"
        ? "安装远程插件"
        : "附加远程文件";
  return (
    <dialog
      ref={ref}
      className="project-directories remote-path-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) props.onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (submitting.current) return;
          const value = path.trim();
          if (!isRemoteAbsolutePath(value)) {
            setError("请输入远程电脑上的完整绝对路径，例如 /Users/name/file.pdf 或 C:\\Users\\name\\file.pdf");
            return;
          }
          submitting.current = true;
          setPending(true);
          setError(null);
          void props
            .onSubmit(value)
            .then(props.onClose)
            .catch((cause) => setError(errorMessage(cause)))
            .finally(() => { submitting.current = false; setPending(false); });
        }}
      >
        <header>
          <h2>{title}</h2>
        </header>
        <p>执行主机：{props.host}</p>
        <label>
          远程绝对路径
          <input
            autoFocus
            value={path}
            disabled={pending}
            placeholder={props.purpose === "attachment" ? "/Users/name/file.pdf 或 C:\\Users\\name\\file.pdf" : "/home/user/project"}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="done"
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault();
            }}
          />
        </label>
        {props.purpose === "attachment" && (
          <p>填写已在这台远程电脑上的文件路径。此入口不会上传手机或当前设备的文件。</p>
        )}
        {error && <p role="alert">{error}</p>}
        <footer>
          <button
            type="button"
            className="secondary"
            disabled={pending}
            onClick={props.onClose}
          >
            取消
          </button>
          <button type="submit" disabled={pending || !path.trim()}>
            {pending ? "正在打开…" : "确定"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

export function isRemoteAbsolutePath(path: string): boolean {
  if (/[\r\n\0]/.test(path)) return false;
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path);
}
