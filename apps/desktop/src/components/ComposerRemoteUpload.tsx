import { Check, Clock, FileText, ImagePlus, Loader2, Minus, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RpcClient } from "../rpc";
import { uploadRemoteFile, type RemoteUploadScope } from "../remoteTransfer";
import { errorMessage } from "../errorMessage";
import { formatFileSize } from "../localFiles";
import { isRemoteAbsolutePath } from "./RemotePathDialog";
import "./RemoteUpload.css";

const MAX_ATTACHMENTS = 10;
type ItemState = "waiting" | "uploading" | "done" | "failed" | "cancelled" | "skipped";
interface QueueItem { id: number; name: string; size: number; state: ItemState }
const STATE_LABEL: Record<ItemState, string> = {
  waiting: "等待中", uploading: "上传中", done: "已收件", failed: "失败", cancelled: "已取消", skipped: "未上传",
};

function ItemIcon({ state }: { state: ItemState }) {
  if (state === "done") return <Check size={16} aria-hidden="true" />;
  if (state === "failed" || state === "cancelled") return <X size={16} aria-hidden="true" />;
  if (state === "skipped") return <Minus size={16} aria-hidden="true" />;
  if (state === "uploading") return <Loader2 size={16} className="remote-upload-spin" aria-hidden="true" />;
  return <Clock size={16} aria-hidden="true" />;
}

/** Keep each upload bound to the client, session or workspace, and draft which selected it. */
export function ComposerRemoteUpload(props: {
  client: RpcClient;
  scope: RemoteUploadScope;
  count: number;
  onAttach: (paths: string[]) => void;
  run: (operation: () => Promise<void>) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const photos = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [path, setPath] = useState("");
  const [items, setItems] = useState<QueueItem[]>([]);
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    return () => {
      mounted.current = false;
      request.current?.abort();
      dialog.current?.close();
    };
  }, []);
  const mark = (id: number, state: ItemState) => {
    if (mounted.current) setItems((current) => current.map((item) => (item.id === id ? { ...item, state } : item)));
  };
  const select = async (selected: File[]) => {
    if (!selected.length || request.current) return;
    if (selected.length + props.count > MAX_ATTACHMENTS) {
      setError("每条消息最多附加 10 个文件，请减少选择后重试");
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    const queue = selected.map((file): QueueItem => ({ id: ++sequence.current, name: file.name, size: file.size, state: "waiting" }));
    setItems(queue);
    setPending(true);
    setError("");
    setStatus("");
    let active = 0;
    try {
      await props.run(async () => {
        for (const [index, file] of selected.entries()) {
          if (controller.signal.aborted) break;
          active = queue[index].id;
          mark(active, "uploading");
          if (mounted.current) setProgress(0);
          const receipt = await uploadRemoteFile(props.client, props.scope, file, controller.signal, (sent, total) => {
            if (!mounted.current || controller.signal.aborted) return;
            setStatus(sent === total ? "正在等待桌面收件回执…" : "");
            setProgress(total ? Math.round(sent / total * 100) : 0);
          });
          // Cancellation can race a completed desktop commit. A confirmed
          // receipt still belongs to the initiating draft, even after unmount.
          props.onAttach([receipt.path]);
          mark(active, "done");
          active = 0;
        }
      });
      if (mounted.current) {
        setStatus(controller.signal.aborted ? "已取消后续上传；已收件文件已附加" : "已收件并附加，可继续编写消息");
        setItems((current) => current.map((item) => (item.state === "waiting" ? { ...item, state: "skipped" } : item)));
      }
    } catch (cause) {
      if (mounted.current) {
        if (active) mark(active, cause instanceof DOMException && cause.name === "AbortError" ? "cancelled" : "failed");
        setItems((current) => current.map((item) => (item.state === "waiting" ? { ...item, state: "skipped" } : item)));
        if (cause instanceof DOMException && cause.name === "AbortError") setStatus("已取消上传");
        else setError(errorMessage(cause));
      }
    } finally {
      request.current = null;
      if (mounted.current) setPending(false);
    }
  };
  const change = (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    void select(selected);
  };
  const full = props.count >= MAX_ATTACHMENTS;
  const anyDone = items.some((item) => item.state === "done");
  return <dialog ref={dialog} className="remote-upload" aria-label="附加远程文件"
    onCancel={(event) => { event.preventDefault(); if (!pending) props.onClose(); }}
    onClick={(event) => { if (event.target === dialog.current && !pending) props.onClose(); }}>
    <span className="remote-upload-grab" aria-hidden="true" />
    <header className="remote-upload-head">
      <div>
        <h2>附加文件</h2>
        <p>上传到电脑当前项目的收件箱 · 已附加 {props.count}/{MAX_ATTACHMENTS}</p>
      </div>
      <button type="button" className="icon-button" aria-label="关闭" disabled={pending} onClick={props.onClose}><X size={18} /></button>
    </header>
    <div className="remote-upload-body">
      <input ref={files} type="file" multiple hidden aria-label="选择本机文件" disabled={pending} onChange={change} />
      <input ref={photos} type="file" multiple hidden aria-label="选择照片原件" accept="image/*,.heic,.heif" disabled={pending} onChange={change} />
      <div className="remote-upload-actions">
        <button type="button" className="remote-upload-tile" aria-label="上传照片原件" disabled={pending || full} onClick={() => photos.current?.click()}>
          <ImagePlus size={22} aria-hidden="true" /><strong>照片</strong><small>从相册选择</small>
        </button>
        <button type="button" className="remote-upload-tile" aria-label="上传本机文件" disabled={pending || full} onClick={() => files.current?.click()}>
          <Upload size={22} aria-hidden="true" /><strong>文件</strong><small>任意类型，保留原件</small>
        </button>
      </div>
      {items.length > 0 && <ul className="remote-upload-queue" aria-label="上传队列">
        {items.map((item) => <li key={item.id} data-state={item.state}>
          <span className="remote-upload-state"><ItemIcon state={item.state} /></span>
          <span className="remote-upload-name" title={item.name}>{item.name}</span>
          <small>{item.state === "uploading" ? `${progress}%` : STATE_LABEL[item.state]} · {formatFileSize(item.size)}</small>
          {item.state === "uploading" && <progress max={100} value={progress} aria-label="上传进度" />}
        </li>)}
      </ul>}
      {status && <p className="remote-upload-note" role="status">{status}</p>}
      {error && <p className="remote-upload-error" role="alert">{error}</p>}
      <details className="remote-upload-existing">
        <summary>附加电脑上已有的文件</summary>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          if (full) { setError("每条消息最多附加 10 个文件"); return; }
          if (!isRemoteAbsolutePath(path.trim())) { setError("请输入远程电脑上的完整绝对路径"); return; }
          props.onAttach([path.trim()]);
          props.onClose();
        }}>
          <label>桌面已有文件路径<input value={path} disabled={pending} placeholder="/Users/名称/项目/文件.pdf" onChange={(event) => setPath(event.target.value)} autoCapitalize="none" autoCorrect="off" /></label>
          <button type="submit" disabled={pending || !path.trim()}><FileText size={16} aria-hidden="true" />附加已有文件</button>
        </form>
      </details>
      <p className="remote-upload-hint">单个文件最大 200 MiB。照片选择器可能转换格式，需要保留 HEIC 原件时请用“文件”。</p>
    </div>
    <footer className="remote-upload-foot">
      {pending
        ? <button type="button" className="remote-upload-danger" onClick={() => { request.current?.abort(); setStatus("正在取消并确认桌面状态…"); }}>取消上传</button>
        : <button type="button" className={anyDone ? "remote-upload-primary" : undefined} onClick={props.onClose}>{anyDone ? "完成" : "关闭"}</button>}
    </footer>
  </dialog>;
}
