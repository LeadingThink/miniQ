import { useEffect, useRef, useState } from "react";
import type { RpcClient } from "../rpc";
import { uploadRemoteFile } from "../remoteTransfer";
import { errorMessage } from "../errorMessage";
import { isRemoteAbsolutePath } from "./RemotePathDialog";
import "./RemotePathDialog.css";

/** Keep each upload bound to the client, session and draft which selected it. */
export function ComposerRemoteUpload(props: {
  client: RpcClient;
  sessionId: string;
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
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [path, setPath] = useState("");
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    return () => {
      mounted.current = false;
      request.current?.abort();
      dialog.current?.close();
    };
  }, []);
  const select = async (selected: File[]) => {
    if (!selected.length || request.current) return;
    if (selected.length + props.count > 10) {
      setError("每条消息最多附加 10 个文件，请减少选择后重试");
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError("");
    try {
      await props.run(async () => {
        for (const file of selected) {
          if (controller.signal.aborted) break;
          if (mounted.current) { setStatus(`正在校验原文件：${file.name}`); setProgress(0); }
          const receipt = await uploadRemoteFile(props.client, props.sessionId, file, controller.signal, (sent, total) => {
            if (!mounted.current || controller.signal.aborted) return;
            setStatus(sent === total ? "正在等待桌面收件回执…" : `正在上传：${file.name}`);
            setProgress(total ? Math.round(sent / total * 100) : 0);
          });
          // Cancellation can race a completed desktop commit. A confirmed
          // receipt still belongs to the initiating draft, even after unmount.
          props.onAttach([receipt.path]);
        }
      });
      if (mounted.current) setStatus(controller.signal.aborted ? "已取消后续上传；已收件文件已附加" : "已收件并附加，可继续编写消息");
    } catch (cause) {
      if (mounted.current) {
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
  return <dialog ref={dialog} className="project-directories remote-path-dialog" aria-label="附加远程文件"
    onCancel={(event) => { event.preventDefault(); if (!pending) props.onClose(); }}>
    <h2>附加文件</h2>
    <input ref={files} type="file" multiple hidden aria-label="选择本机文件" disabled={pending} onChange={change} />
    <input ref={photos} type="file" multiple hidden aria-label="选择照片原件" accept="image/*,.heic,.heif" disabled={pending} onChange={change} />
    <button type="button" disabled={pending || props.count >= 10} onClick={() => files.current?.click()}>上传本机文件</button>
    <button type="button" disabled={pending || props.count >= 10} onClick={() => photos.current?.click()}>上传照片原件</button>
    <p>原文件保存到当前会话的项目收件箱，收到回执后加入附件。每条消息最多 10 个附件。</p>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (pending) return;
      if (props.count >= 10) { setError("每条消息最多附加 10 个文件"); return; }
      if (!isRemoteAbsolutePath(path.trim())) { setError("请输入远程电脑上的完整绝对路径"); return; }
      props.onAttach([path.trim()]);
      props.onClose();
    }}>
      <label>桌面已有文件路径<input value={path} disabled={pending} onChange={(event) => setPath(event.target.value)} autoCapitalize="none" autoCorrect="off" /></label>
      <button type="submit" disabled={pending || !path.trim()}>附加已有文件</button>
    </form>
    {status && <p role="status">{status}</p>}
    {error && <p role="alert">{error}</p>}
    {pending && <><progress max={100} value={progress} aria-label="上传进度" /><button type="button" onClick={() => { request.current?.abort(); setStatus("正在取消并确认桌面状态…"); }}>取消上传</button></>}
    <button type="button" disabled={pending} onClick={props.onClose}>完成</button>
  </dialog>;
}
