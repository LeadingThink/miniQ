import { Square, Upload, ImagePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import { uploadRemoteFile } from "../remoteTransfer";
import type { FileReadOptions } from "../remoteFiles";
export function RemoteFileUpload({ access, onError }: {
    access: FileReadOptions;
    onError?: (message: string) => void;
}) {
    const input = useRef<HTMLInputElement>(null);
    const photos = useRef<HTMLInputElement>(null);
    const request = useRef<AbortController | undefined>(undefined);
    const [progress, setProgress] = useState<number | null>(null);
    const [receipts, setReceipts] = useState<string[]>([]);
    const [phase, setPhase] = useState("");
    const generation = useRef(0);
    useEffect(() => {
        setReceipts([]);
        setProgress(null);
        return () => { generation.current++; request.current?.abort(); request.current = undefined; };
    }, [access.client, access.sessionId]);
    const select = async (files: FileList | null) => {
        if (!files?.length || !access.client || !access.sessionId || request.current)
            return;
        const selected = Array.from(files);
        const scope = generation.current;
        const controller = new AbortController();
        request.current = controller;
        setProgress(0);
        setReceipts([]);
        for (const file of selected) {
            if (controller.signal.aborted)
                break;
            setPhase(`正在校验原文件：${file.name}`);
            try {
                const result = await uploadRemoteFile(access.client, access.sessionId, file, controller.signal, (sent, total) => { if (scope === generation.current) {
                    setPhase(sent === total ? "正在等待桌面收件回执…" : `正在上传：${file.name}`);
                    setProgress(total ? Math.round(sent / total * 100) : 0);
                } });
                if (scope === generation.current)
                    setReceipts((current) => [...current, `已收件：${result.path}`]);
            }
            catch (cause) {
                if (scope === generation.current) {
                    const message = controller.signal.aborted && cause instanceof DOMException && cause.name === "AbortError" ? "已取消" : `失败：${errorMessage(cause)}`;
                    setReceipts((current) => [...current, `${file.name} · ${message}`]);
                    if (!controller.signal.aborted)
                        onError?.(message);
                }
            }
        }
        if (request.current === controller) {
            request.current = undefined;
            setProgress(null);
        }
    };
    const change = (event: React.ChangeEvent<HTMLInputElement>) => { void select(event.currentTarget.files); event.currentTarget.value = ""; };
    return <div className="remote-file-upload" aria-live="polite">
    <input ref={input} type="file" multiple hidden aria-label="选择本机文件" onChange={change}/>
    <input ref={photos} type="file" multiple hidden aria-label="选择照片原件" accept="image/*,.heic,.heif" onChange={change}/>
    {progress === null ? <>
      <button type="button" className="ghost" disabled={!access.client || !access.sessionId} onClick={() => input.current?.click()}><Upload size={16}/>上传本机文件</button>
      <button type="button" className="ghost" disabled={!access.client || !access.sessionId} onClick={() => photos.current?.click()}><ImagePlus size={16}/>上传照片原件</button>
      <small>保存到当前会话的项目收件箱 · 每个文件最多 200 MiB</small>
    </> : <div role="status"><span>{phase}</span><progress max={100} value={progress}/><button type="button" className="ghost" onClick={() => { setPhase("正在取消并确认桌面状态…"); request.current?.abort(); }}><Square size={14}/>取消上传 {progress}%</button></div>}
    {receipts.map((receipt, index) => <p key={index} role="status">{receipt}</p>)}
  </div>;
}
