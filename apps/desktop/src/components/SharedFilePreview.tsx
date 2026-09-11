import { lazy, Suspense, useEffect, useState } from "react";
import { X } from "lucide-react";
import { sharedFileUrl, type SharedFile } from "../sharing";
import { formatFileSize } from "../localFiles";
import { SharedMarkdown } from "./SharedMarkdown";
import { errorMessage } from "../errorMessage";

const Pdf = lazy(() => import("./PdfPreview").then((module) => ({ default: module.PdfPreview })));
const Spreadsheet = lazy(() => import("./SpreadsheetPreview").then((module) => ({ default: module.SpreadsheetPreview })));

function extension(name: string) { return name.split(".").pop()!.toLowerCase(); }
const TEXT = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "js", "ts", "py", "rs", "css", "html", "htm", "svg", "yaml", "yml", "xml"]);
const BINARY = new Set(["pdf", "xlsx", "xlsm"]);
function asBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取分享文件"));
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.readAsDataURL(blob);
  });
}

function SharedSvg({ source, name }: { source: string; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const value = URL.createObjectURL(new Blob([source], { type: "image/svg+xml" }));
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [source]);
  // SVG as an image cannot execute scripts or fetch document resources, and
  // scales to the mobile viewport even when the source has fixed dimensions.
  return url ? <img src={url} alt={name} /> : <p role="status">正在加载图片…</p>;
}

export function SharedFilePreview(props: { shareId: string; file: SharedFile; onClose: () => void }) {
  return <FilePreview key={props.file.id} {...props} />;
}

function FilePreview({ shareId, file, onClose }: { shareId: string; file: SharedFile; onClose: () => void }) {
  const ext = extension(file.name);
  const url = sharedFileUrl(shareId, file);
  const [body, setBody] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const limited = file.size > 64 * 1024 * 1024;
  const image = ["png", "jpg", "jpeg", "webp", "gif"].includes(ext);
  const video = ["mp4", "webm", "mov"].includes(ext);
  const audio = ["mp3", "m4a", "wav"].includes(ext);
  useEffect(() => {
    if ((!TEXT.has(ext) && !BINARY.has(ext)) || limited) return;
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(url, { signal: controller.signal, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
      if (!response.ok) throw new Error("文件不可用或分享已撤销");
      const blob = await response.blob();
      if (blob.size !== file.size) throw new Error("文件传输不完整，请重新打开");
      const content = BINARY.has(ext) ? await asBase64(blob) : await blob.text();
      if (!controller.signal.aborted) setBody(content);
    })().catch((cause) => { if (!controller.signal.aborted) setError(errorMessage(cause)); });
    return () => controller.abort();
  }, [ext, file.size, limited, url]);
  return <aside className="shared-preview" aria-label="分享文件预览">
    <header><strong>{file.name}</strong><span>{formatFileSize(file.size)}</span>
      <a href={url} download={file.name} target="_blank" rel="noreferrer">下载</a>
      <button type="button" className="icon-button" aria-label="关闭文件预览" onClick={onClose}><X size={18} /></button></header>
    {error && <p role="alert">{error}</p>}
    <div className="shared-preview-body">
      {image ? <img src={url} alt={file.name} onError={() => setError("图片不可用或分享已撤销")} />
        : video ? <video src={url} controls playsInline preload="metadata" onError={() => setError("视频不可用或当前浏览器不支持，请下载查看")} />
        : audio ? <audio src={url} controls preload="metadata" onError={() => setError("音频不可用或当前浏览器不支持，请下载查看")} />
        : limited ? <p>此文件超过 64 MB 在线解析上限，可下载完整文件。</p>
        : body !== null ? <Suspense fallback={<p role="status">正在加载预览…</p>}>
          {ext === "pdf" ? <Pdf dataBase64={body} onError={setError} />
            : ["xlsx", "xlsm"].includes(ext) ? <Spreadsheet dataBase64={body} onError={setError} />
            : ["md", "markdown"].includes(ext) ? <SharedMarkdown>{body}</SharedMarkdown>
            : ext === "svg" ? <SharedSvg source={body} name={file.name} />
            : ["html", "htm"].includes(ext) ? <iframe title={file.name} sandbox="" referrerPolicy="no-referrer" srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'">${body}`} />
            : <pre className="shared-text">{body}</pre>}
        </Suspense>
        : TEXT.has(ext) || BINARY.has(ext) ? !error && <p role="status">正在读取文件…</p>
        : <p>此格式可下载到设备后查看。</p>}
    </div>
  </aside>;
}
