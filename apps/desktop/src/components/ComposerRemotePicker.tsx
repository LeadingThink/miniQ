import { FileText, ImagePlus, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComposerUploadSelection } from "../composerUploads";
import { usesNativeUploadPicker } from "../remoteUploadSource";
import { isRemoteAbsolutePath } from "./RemotePathDialog";
import "./RemoteUpload.css";

/** The picker closes on selection; its hidden inputs stay alive while originals are staged. */
export function ComposerRemotePicker(props: {
  open: boolean;
  count: number;
  onSelect: (selection: ComposerUploadSelection) => Promise<void>;
  onAttach: (paths: string[]) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  const nextInput = useRef(2);
  const [inputs, setInputs] = useState([
    { id: 0, kind: "files" as const, active: true },
    { id: 1, kind: "photos" as const, active: true },
  ]);
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    if (props.open) {
      setError("");
      setPath("");
      dialog.current?.showModal();
    } else if (dialog.current?.open) {
      dialog.current.close();
    }
  }, [props.open]);
  const select = (selection: ComposerUploadSelection) => {
    const result = props.onSelect(selection);
    props.onClose();
    return result;
  };
  const change = (event: React.ChangeEvent<HTMLInputElement>, id: number, kind: "files" | "photos") => {
    const input = event.currentTarget;
    const selection = Array.from(input.files ?? []);
    if (!selection.length) return;
    // Each selection keeps its provider input alive, even if another picker is
    // opened before its originals finish staging.
    const fresh = { id: nextInput.current++, kind, active: true };
    setInputs(current => [...current.map(item => item.id === id ? { ...item, active: false } : item), fresh]);
    void select(selection).finally(() => {
      input.value = "";
      setInputs(current => current.filter(item => item.id !== id));
    });
  };
  const choose = (kind: "files" | "photos") => {
    if (usesNativeUploadPicker()) void select(kind);
    else (kind === "files" ? files : photos).current?.click();
  };
  return <>
    {inputs.map(input => <input key={input.id} ref={input.active ? input.kind === "files" ? files : photos : undefined}
      type="file" multiple hidden aria-label={input.active ? input.kind === "files" ? "选择本机文件" : "选择照片原件" : undefined}
      accept={input.kind === "photos" ? "image/*,.heic,.heif" : undefined}
      onChange={event => change(event, input.id, input.kind)} />)}
    <dialog ref={dialog} className="remote-upload" aria-label="附加远程文件"
      onCancel={event => { event.preventDefault(); props.onClose(); }}
      onClick={event => { if (event.target === dialog.current) props.onClose(); }}>
      <span className="remote-upload-grab" aria-hidden="true" />
      <header className="remote-upload-head">
        <div><h2>附加文件</h2><p>上传到电脑当前项目的收件箱 · 已附加 {props.count} 个</p></div>
        <button type="button" className="icon-button" aria-label="关闭" onClick={props.onClose}><X size={18} /></button>
      </header>
      <div className="remote-upload-body">
        <div className="remote-upload-actions">
          <button type="button" className="remote-upload-tile" aria-label="上传照片原件" onClick={() => choose("photos")}>
            <ImagePlus size={22} aria-hidden="true" /><strong>照片</strong><small>从相册选择</small>
          </button>
          <button type="button" className="remote-upload-tile" aria-label="上传本机文件" onClick={() => choose("files")}>
            <Upload size={22} aria-hidden="true" /><strong>文件</strong><small>任意类型，保留原件</small>
          </button>
        </div>
        <details className="remote-upload-existing">
          <summary>附加电脑上已有的文件</summary>
          <form onSubmit={event => {
            event.preventDefault();
            if (!isRemoteAbsolutePath(path.trim())) { setError("请输入远程电脑上的完整绝对路径"); return; }
            props.onAttach([path.trim()]);
            props.onClose();
          }}>
            <label>桌面已有文件路径<input value={path} placeholder="/Users/名称/项目/文件.pdf" onChange={event => setPath(event.target.value)} autoCapitalize="none" autoCorrect="off" /></label>
            <button type="submit" disabled={!path.trim()}><FileText size={16} aria-hidden="true" />附加已有文件</button>
          </form>
        </details>
        {error && <p className="remote-upload-error" role="alert">{error}</p>}
        <p className="remote-upload-hint">单个文件最大 200 MiB。照片选择器可能转换格式，需要保留 HEIC 原件时请用“文件”。</p>
      </div>
    </dialog>
  </>;
}
