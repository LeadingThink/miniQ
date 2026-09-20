import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import "./ProjectDirectories.css";

export function RemotePathDialog(props: {
  host: string;
  purpose: "project" | "attachment" | "plugin";
  onSubmit: (path: string) => Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
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
      className="project-directories"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) props.onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          const value = path.trim();
          if (!value.startsWith("/") || /[\r\n\0]/.test(value)) {
            setError("请输入远程主机上的绝对路径，例如 /home/user/project");
            return;
          }
          setPending(true);
          setError(null);
          void props
            .onSubmit(value)
            .then(props.onClose)
            .catch((cause) => setError(errorMessage(cause)))
            .finally(() => setPending(false));
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
            placeholder="/home/user/project"
            onChange={(event) => setPath(event.target.value)}
          />
        </label>
        {props.purpose === "attachment" && (
          <p>选择已在远程主机上的文件。本机文件请先通过 scp 或其他方式上传。</p>
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
