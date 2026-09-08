import { ChevronLeft, ChevronRight, Download, Maximize, Minimize, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { loadObservation, observationImage, observationPages } from "../computerObservation";
import type { RpcClient } from "../rpc";
import type { ToolCall } from "../types";
import "./ComputerObservation.css";

export function ComputerObservation({ call, client }: { call: ToolCall; client: RpcClient }) {
  const [page, setPage] = useState(0);
  const pages = observationPages(call);
  const image = observationImage(call, page);
  const title = call.toolName === "computer_use" ? "桌面观察" : call.toolName === "view_pdf" ? `PDF 第 ${pages[page]} 页` : call.toolName === "view_image" ? "图片观察" : "浏览器观察";
  const alt = call.toolName === "computer_use" ? "操作后的桌面截图" : call.toolName === "browser_automation" ? "操作后的网页截图" : title;
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [original, setOriginal] = useState(false);
  useEffect(() => { setPage(0); setOriginal(false); }, [call.id]);
  useEffect(() => {
    if (!image) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);
    void loadObservation(client, call, controller.signal, page).then(blob => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(String(cause));
    });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [client, call.id, call.sessionId, image?.id, attempt, page]);
  if (!image) return null;
  return <figure className="computer-observation">
    <figcaption>
      <strong>{title}</strong>
      <span className="observation-size">{image.width} × {image.height}</span>
      <div className="observation-actions" role="toolbar" aria-label="截图操作">
      {pages.length > 1 && <>
        <button type="button" className="icon-button" title="上一页" aria-label="上一页" disabled={page === 0} onClick={() => setPage(value => value - 1)}><ChevronLeft size={15} /></button>
        <span className="observation-page-count">{page + 1} / {pages.length}</span>
        <button type="button" className="icon-button" title="下一页" aria-label="下一页" disabled={page + 1 >= pages.length} onClick={() => setPage(value => value + 1)}><ChevronRight size={15} /></button>
      </>}
      <button type="button" className="icon-button" title={original ? "适应宽度" : "原始尺寸"}
        aria-label={original ? "适应宽度" : "原始尺寸"} aria-pressed={original} onClick={() => setOriginal(!original)}>
        {original ? <Minimize size={15} /> : <Maximize size={15} />}
      </button>
      {url && <a className="icon-button" title="下载截图" aria-label="下载截图" href={url} download={`miniq-observation-${image.id}.png`}><Download size={15} /></a>}
      <button type="button" className="icon-button" title="重新加载截图" aria-label="重新加载截图" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={15} /></button>
      </div>
    </figcaption>
    <div className={`computer-observation-image ${original ? "original" : ""}`} style={{ aspectRatio: `${image.width} / ${image.height}` }}>
      {error ? <div role="alert">{error}</div> : url
        ? <img src={url} alt={alt} width={image.width} height={image.height} onError={() => setError("截图无法显示，请重新加载")} />
        : <div role="status">正在加载截图</div>}
    </div>
  </figure>;
}
