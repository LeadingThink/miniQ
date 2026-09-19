import { Download, Share2, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { readRemoteFile, type FileReadOptions } from "../remoteFiles";
import { useSessionFileAccess } from "../sessionFileAccess";
import { decodeBase64 } from "../previewBinary";
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
  preview?: Pick<
    LocalFilePreview,
    "path" | "mimeType" | "content" | "dataBase64"
  >;
}

function useRemoteDownload({ path, preview, onError }: DownloadProps) {
  const access = useSessionFileAccess();
  const request = useRef<AbortController>();
  const [progress, setProgress] = useState<number | null>(null);
  const [prepared, setPrepared] = useState<PreparedFile | null>(null);
  const preparedRef = useRef<PreparedFile | null>(null);
  useEffect(() => {
    setProgress(null);
    setPrepared(null);
    return () => {
      request.current?.abort();
      request.current = undefined;
      const current = preparedRef.current;
      preparedRef.current = null;
      // Safari can still be reading the file just after the preview closes.
      if (current)
        window.setTimeout(() => URL.revokeObjectURL(current.url), 60_000);
    };
  }, [path, access, preview?.content, preview?.dataBase64]);
  async function download() {
    if (!access || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setProgress(0);
    try {
      const existing =
        preview?.path === path &&
        (preview.content !== null || preview.dataBase64 !== null);
      const file = existing
        ? preview
        : await readRemoteFile(path, {
            ...access,
            signal: controller.signal,
            download: true,
            onProgress: (received, total) =>
              setProgress(total ? Math.round((received / total) * 100) : 100),
          });
      controller.signal.throwIfAborted();
      const name = path.split(/[\\/]/).at(-1) || "download";
      const downloadable = new File(
        [file.content ?? decodeBase64(file.dataBase64 ?? "")],
        name,
        { type: file.mimeType },
      );
      const shareable =
        typeof navigator.share === "function" &&
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
  return {
    progress,
    prepared:
      prepared?.path === path && prepared.access === access ? prepared : null,
    download,
    cancel: () => request.current?.abort(),
    disabled: !path || !access?.client || !access.sessionId,
  };
}

export function RemoteFileDownload(props: DownloadProps) {
  const { progress, prepared, download, cancel, disabled } =
    useRemoteDownload(props);
  if (prepared && progress === null)
    return <PreparedFileActions prepared={prepared} onError={props.onError} />;
  return progress === null ? (
    <button
      type="button"
      className="icon-button"
      aria-label="下载到当前设备"
      title="下载到当前设备"
      disabled={disabled}
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
      onClick={cancel}
    >
      <Square size={14} />
      <small>{progress}%</small>
    </button>
  );
}

function PreparedFileActions({
  prepared,
  onError,
}: {
  prepared: PreparedFile;
  onError: DownloadProps["onError"];
}) {
  return (
    <>
      <a
        className="icon-button"
        href={prepared.url}
        download={prepared.file.name}
        aria-label="文件已就绪，保存到当前设备"
        title="文件已就绪，点击保存到当前设备"
      >
        <Download size={16} />
      </a>
      {prepared.shareable && (
        <button
          type="button"
          className="icon-button"
          aria-label="分享或存储文件"
          title="分享或存储文件"
          onClick={() => {
            // Invoke share in this click handler before any await: Web Share needs
            // transient activation, which a remote transfer would consume.
            void navigator.share({ files: [prepared.file] }).catch((cause) => {
              if (
                !(
                  cause &&
                  typeof cause === "object" &&
                  "name" in cause &&
                  cause.name === "AbortError"
                )
              )
                onError(cause instanceof Error ? cause.message : String(cause));
            });
          }}
        >
          <Share2 size={16} />
        </button>
      )}
    </>
  );
}
