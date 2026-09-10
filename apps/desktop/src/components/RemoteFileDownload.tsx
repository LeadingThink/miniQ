import { Download, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { readRemoteFile } from "../remoteFiles";
import { useSessionFileAccess } from "../sessionFileAccess";
import { decodeBase64 } from "../previewBinary";

export function RemoteFileDownload({
  path,
  onError,
}: {
  path: string;
  onError: (error: string) => void;
}) {
  const access = useSessionFileAccess();
  const request = useRef<AbortController>();
  const [progress, setProgress] = useState<number | null>(null);
  useEffect(() => {
    setProgress(null);
    return () => {
      request.current?.abort();
      request.current = undefined;
    };
  }, [path, access]);
  async function download() {
    if (!access || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setProgress(0);
    try {
      const file = await readRemoteFile(path, {
        ...access,
        signal: controller.signal,
        download: true,
        onProgress: (received, total) =>
          setProgress(total ? Math.round((received / total) * 100) : 100),
      });
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(
        new Blob([decodeBase64(file.dataBase64 ?? "")], {
          type: file.mimeType,
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = path.split(/[\\/]/).at(-1) || "download";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // Safari may begin reading a download after the initiating click returns.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      if (!controller.signal.aborted)
        onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        setProgress(null);
      }
    }
  }
  return progress === null ? (
    <button
      type="button"
      className="icon-button"
      aria-label="下载到当前设备"
      title="下载到当前设备"
      disabled={!path}
      onClick={() => void download()}
    >
      <Download size={16} />
    </button>
  ) : (
    <button
      type="button"
      className="icon-button"
      aria-label="取消文件下载"
      title={`下载 ${progress}% · 点击取消`}
      onClick={() => request.current?.abort()}
    >
      <Square size={14} />
      <small>{progress}%</small>
    </button>
  );
}
