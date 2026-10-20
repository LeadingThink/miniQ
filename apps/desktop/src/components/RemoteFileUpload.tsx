import { Square, Upload, ImagePlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import { uploadRemoteFile } from "../remoteTransfer";
import { pickUploadSources, releaseUploadSources, stageBrowserUploadSources, usesNativeUploadPicker, type RemoteUploadSource } from "../remoteUploadSource";
import { throwIfAborted } from "../abortSignal";
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
    const select = async (selection: File[] | "files" | "photos") => {
        if ((Array.isArray(selection) && !selection.length) || !access.client || !access.sessionId || request.current)
            return;
        const scope = generation.current;
        const client = access.client;
        const sessionId = access.sessionId;
        const controller = new AbortController();
        request.current = controller;
        setProgress(0);
        setReceipts([]);
        setPhase("正在准备所选原件…");
        let selected: RemoteUploadSource[] = [];
        try {
            selected = Array.isArray(selection)
                ? await stageBrowserUploadSources(selection, controller.signal)
                : await pickUploadSources(selection, 10, controller.signal);
            throwIfAborted(controller.signal);
            for (const file of selected) {
                if (controller.signal.aborted) break;
                setPhase(`正在上传：${file.name}`);
                setProgress(0);
                try {
                    const result = await uploadRemoteFile(client, { sessionId }, file, controller.signal, (sent, total) => {
                        if (scope !== generation.current) return;
                        setPhase(sent === total ? "正在等待桌面收件回执…" : `正在上传：${file.name}`);
                        setProgress(total ? Math.round(sent / total * 100) : 0);
                    });
                    if (scope === generation.current)
                        setReceipts((current) => [...current, `已收件：${result.path}`]);
                } catch (cause) {
                    if (scope === generation.current) {
                        const message = controller.signal.aborted && cause instanceof DOMException && cause.name === "AbortError" ? "已取消" : `失败：${errorMessage(cause)}`;
                        setReceipts((current) => [...current, `${file.name} · ${message}`]);
                        if (!controller.signal.aborted) onError?.(message);
                    }
                }
            }
        } catch (cause) {
            if (scope === generation.current) {
                const message = controller.signal.aborted ? "已取消" : `失败：${errorMessage(cause)}`;
                setReceipts([message]);
                if (!controller.signal.aborted) onError?.(message);
            }
        } finally {
            await releaseUploadSources(selected);
            if (request.current === controller) {
                request.current = undefined;
                setProgress(null);
            }
        }
    };
    const change = (event: React.ChangeEvent<HTMLInputElement>) => {
        const element = event.currentTarget;
        void select(Array.from(element.files ?? [])).finally(() => { element.value = ""; });
    };
    const choose = (kind: "files" | "photos") => {
        if (usesNativeUploadPicker()) void select(kind);
        else (kind === "files" ? input : photos).current?.click();
    };
    return <div className="remote-file-upload" aria-live="polite">
    <input ref={input} type="file" multiple hidden aria-label="选择本机文件" disabled={progress !== null} onChange={change}/>
    <input ref={photos} type="file" multiple hidden aria-label="选择照片" accept="image/*,.heic,.heif" disabled={progress !== null} onChange={change}/>
    {progress === null ? <>
      <div className="remote-file-upload-actions">
        <button type="button" className="ghost" disabled={!access.client || !access.sessionId} onClick={() => choose("files")}><Upload size={16}/>上传本机文件</button>
        <button type="button" className="ghost" disabled={!access.client || !access.sessionId} onClick={() => choose("photos")}><ImagePlus size={16}/>上传照片</button>
      </div>
      <small>保存到当前会话的项目收件箱 · 每个文件最多 200 MiB。照片选择器可能转换格式；保留 HEIC 原件请使用“上传本机文件”选择原文件。</small>
    </> : <div role="status" className="remote-file-upload-progress"><span>{phase}</span><progress max={100} value={progress}/><button type="button" className="ghost" onClick={() => { setPhase("正在取消并确认桌面状态…"); request.current?.abort(); }}><Square size={14}/>取消上传 {progress}%</button></div>}
    {receipts.map((receipt, index) => <p key={index} role="status" className={receipt.includes("失败") ? "remote-file-receipt failed" : "remote-file-receipt"}>{receipt}</p>)}
  </div>;
}
