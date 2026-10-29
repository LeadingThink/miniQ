import { Download, Share2, Square } from "lucide-react";
import { throwIfAborted } from "../abortSignal";
import { useEffect, useRef, useState } from "react";
import { readRemoteFile, type FileReadOptions } from "../remoteFiles";
import { validateDescriptor, type SignedDownload } from "../remoteTransfer";
import { Capacitor } from "@capacitor/core";
import { saveRemoteFile } from "../nativeFileTransfer";
import { useSessionFileAccess } from "../sessionFileAccess";
import type { LocalFilePreview } from "../localFiles";
type PreparedFile = {
    url: string;
    file: File;
    shareable: boolean;
    path: string;
    access: FileReadOptions;
};
interface DownloadProps {
    path: string;
    onError: (error: string) => void;
    preview?: Pick<LocalFilePreview, "path" | "mimeType" | "content" | "dataBase64" | "blob">;
}
function useRemoteDownload({ path, preview, onError }: DownloadProps) {
    const access = useSessionFileAccess();
    const request = useRef<AbortController>(undefined);
    const [progress, setProgress] = useState<number | null>(null);
    const [receipt, setReceipt] = useState<string | null>(null);
    const [prepared, setPrepared] = useState<PreparedFile | null>(null);
    const preparedRef = useRef<PreparedFile | null>(null);
    useEffect(() => {
        setProgress(null);
        setReceipt(null);
        setPrepared(null);
        return () => {
            request.current?.abort();
            request.current = undefined;
            const current = preparedRef.current;
            preparedRef.current = null;
            // Safari can still be reading the file just after the preview closes.
            if (current)
                window.setTimeout(() => URL.revokeObjectURL(current.url), 60000);
        };
    }, [path, access, preview?.content, preview?.dataBase64]);
    async function download() {
        if (!access || request.current)
            return;
        const controller = new AbortController();
        request.current = controller;
        setProgress(0);
        setReceipt(null);
        try {
            const name = path.split(/[\\/]/).at(-1) || "download";
            if (access.client && access.sessionId && Capacitor.isNativePlatform()) {
                if (access.client.sshHost) throw new Error("手机端暂不支持保存 SSH 文件，请在电脑端下载；文件预览可正常使用");
                const described = await access.client.call<{
                    mimeType: string;
                    revision: string;
                }>("file.describe", { sessionId: access.sessionId, path }, { signal: controller.signal });
                for (let attempt = 0; attempt < 2; attempt++) {
                    let signed = await access.client.call<SignedDownload>("file.download.prepare", { sessionId: access.sessionId, path, revision: described.revision }, { signal: controller.signal, timeoutMs: 600000 });
                    if (signed.expiresAt <= Date.now())
                        signed = await access.client.call<SignedDownload>("file.download.prepare", { sessionId: access.sessionId, path, revision: described.revision }, { signal: controller.signal, timeoutMs: 600000 });
                    signed = validateDescriptor(signed);
                    try {
                        const result = await saveRemoteFile({ url: signed.getUrl, filename: name, mimeType: described.mimeType, size: signed.size, sha256: signed.sha256 }, {
                            signal: controller.signal,
                            onProgress: (received, total) => setProgress(total ? Math.round((received / total) * 100) : 100),
                        });
                        if (result.status === "cancelled")
                            await access.client.call("file.transfer.cancel", { sessionId: access.sessionId, transferId: signed.transferId });
                        if (!controller.signal.aborted)
                            setReceipt(result.status === "cancelled" ? "已取消保存" : result.status === "saved" ? "文件已保存" : "系统分享已完成");
                        return;
                    }
                    catch (cause) {
                        await access.client.call("file.transfer.cancel", { sessionId: access.sessionId, transferId: signed.transferId }).catch(() => { });
                        if (!controller.signal.aborted && attempt === 0 && cause instanceof Error && /401|403|expired|过期/i.test(cause.message))
                            continue;
                        throw cause;
                    }
                }
                return;
            }
            if (!access.client || !access.sessionId)
                return;
            const file = await readRemoteFile(path, { ...access, download: true, signal: controller.signal,
                onProgress: (received, total) => setProgress(total ? Math.round((received / total) * 100) : 100),
            });
            throwIfAborted(controller.signal);
            if (!file.blob) throw new Error("无法下载文件");
            const downloadable = new File([file.blob], name, { type: file.mimeType });
            const shareable = typeof navigator.share === "function" &&
                Boolean(navigator.canShare?.({ files: [downloadable] }));
            const url = URL.createObjectURL(downloadable);
            const result = {
                url,
                file: downloadable,
                shareable,
                path,
                access,
            };
            preparedRef.current = result;
            setPrepared(result);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = name;
            document.body.append(anchor);
            anchor.click();
            anchor.remove();
            // Keep a real link so Safari users can save with a fresh user gesture if
            // the asynchronous download was blocked, without transferring it again.
        }
        catch (cause) {
            if (!controller.signal.aborted)
                onError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            if (request.current === controller) {
                request.current = undefined;
                setProgress(null);
            }
        }
    }
    return {
        progress,
        receipt,
        prepared: prepared?.path === path && prepared.access === access ? prepared : null,
        download,
        cancel: () => request.current?.abort(),
        disabled: !path || !access?.client || !access.sessionId,
    };
}
export function RemoteFileDownload(props: DownloadProps) {
    const { progress, receipt, prepared, download, cancel, disabled } = useRemoteDownload(props);
    if (prepared && progress === null)
        return <PreparedFileActions prepared={prepared} onError={props.onError}/>;
    return progress === null ? (<>{receipt && <span role="status" className="remote-download-receipt">{receipt}</span>}<button type="button" className="icon-button" aria-label="下载到当前设备" title="下载到当前设备" disabled={disabled} onClick={() => void download()}>
      <Download size={16}/>
    </button></>) : (<button type="button" className="icon-button" aria-label="取消文件下载" title={`下载 ${progress}% · 点击取消`} onClick={cancel}>
      <Square size={14}/>
      <small>{progress}%</small>
    </button>);
}
function PreparedFileActions({ prepared, onError, }: {
    prepared: PreparedFile;
    onError: DownloadProps["onError"];
}) {
    return (<>
      <a className="icon-button" href={prepared.url} download={prepared.file.name} aria-label="文件已就绪，保存到当前设备" title="文件已就绪，点击保存到当前设备">
        <Download size={16}/>
      </a>
      {prepared.shareable && (<button type="button" className="icon-button" aria-label="分享或存储文件" title="分享或存储文件" onClick={() => {
                // Invoke share in this click handler before any await: Web Share needs
                // transient activation, which a remote transfer would consume.
                void navigator.share({ files: [prepared.file] }).catch((cause) => {
                    if (!(cause &&
                        typeof cause === "object" &&
                        "name" in cause &&
                        cause.name === "AbortError"))
                        onError(cause instanceof Error ? cause.message : String(cause));
                });
            }}>
          <Share2 size={16}/>
        </button>)}
    </>);
}
