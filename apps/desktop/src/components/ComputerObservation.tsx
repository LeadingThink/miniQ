import { AlertTriangle, ChevronLeft, ChevronRight, Download, Expand, ExternalLink, Maximize, Minimize, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { loadObservation, observationImage, observationPages } from "../computerObservation";
import type { RpcClient } from "../rpc";
import type { ToolCall } from "../types";
import "./ComputerObservation.css";
import { ObservationViewer } from "./ObservationViewer";

export function ComputerObservation({ call, client }: { call: ToolCall; client: RpcClient }) {
  const [page, setPage] = useState(0);
  const pages = observationPages(call);
  const image = observationImage(call, page);
  const target = (call.output as { target?: { appName?: unknown; title?: unknown } } | null)?.target;
  const appName = call.toolName === "app_automation" && typeof target?.appName === "string" ? target.appName : "";
  const title = call.toolName === "app_automation" ? `应用观察${appName ? ` · ${appName}` : ""}` : call.toolName === "computer_use" ? "桌面观察" : call.toolName === "view_pdf" ? `PDF 第 ${pages[page]} 页` : call.toolName === "view_image" ? "图片观察" : "浏览器观察";
  const alt = call.toolName === "app_automation" ? `${appName || "目标应用"}窗口截图` : call.toolName === "computer_use" ? "操作后的桌面截图" : call.toolName === "browser_automation" ? "操作后的网页截图" : title;
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [original, setOriginal] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const input = call.input as Record<string, unknown> | undefined;
  const output = call.output as Record<string, unknown> | undefined;
  const observationError = typeof output?.observationError === "string" ? output.observationError : null;
  const needsVerification = output?.actionDispatched === true && observationError !== null;
  const browserUrl = call.toolName === "browser_automation"
    ? (typeof output?.url === "string" ? output.url : typeof input?.url === "string" ? input.url : null)
    : null;
  const browserTabId = call.toolName === "browser_automation" && typeof output?.tabId === "string" ? output.tabId : undefined;
  useEffect(() => { setPage(0); setOriginal(false); setExpanded(false); }, [call.id, call.sessionId]);
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
  if (!image) {
    if (!needsVerification || (call.toolName !== "computer_use" && call.toolName !== "app_automation")) return null;
    return <div className="computer-observation-pending" role="status">
      <AlertTriangle size={18} aria-hidden="true" />
      <div>
        <strong>动作已发出，结果待核验</strong>
        <span>{observationError}</span>
        <span>请重新观察当前界面，不要仅因观察失败而重复该动作。</span>
      </div>
    </div>;
  }
  return <figure className="computer-observation">
    <figcaption>
      <strong title={typeof target?.title === "string" ? target.title : undefined}>{title}</strong>
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
      {url && <button type="button" className="icon-button" title="全屏查看截图" aria-label="全屏查看截图" onClick={() => setExpanded(true)}><Expand size={15} /></button>}
      {browserUrl && (client.mode === "remote"
        ? <a className="icon-button" href={/^https?:\/\//i.test(browserUrl) ? browserUrl : undefined} target="_blank" rel="noopener noreferrer" title="在本机浏览器打开（不共享桌面登录状态）" aria-label="在本机浏览器打开"><ExternalLink size={15} /></a>
        : <button type="button" className="icon-button" title="在右侧内置浏览器打开" aria-label="在右侧内置浏览器打开" onClick={() => window.dispatchEvent(new CustomEvent("miniq:open-browser", { detail: { url: browserUrl, ...(browserTabId ? { tabId: browserTabId } : {}) } }))}><ExternalLink size={15} /></button>)}
      <button type="button" className="icon-button" title="重新加载截图" aria-label="重新加载截图" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={15} /></button>
      </div>
    </figcaption>
    <div className={`computer-observation-image ${original ? "original" : ""}`} style={{ aspectRatio: `${image.width} / ${image.height}` }}>
      {error ? <div role="alert">{error}</div> : url
        ? <img src={url} alt={alt} width={image.width} height={image.height} decoding="async" onError={() => setError("截图无法显示，请重新加载")} />
        : <div role="status">正在加载截图</div>}
    </div>
    {expanded && url && <ObservationViewer key={`${call.id}:${page}:${url}`} url={url} title={title}
      width={image.width} height={image.height} filename={`miniq-observation-${image.id}.png`}
      onClose={() => setExpanded(false)} onError={(message) => { setExpanded(false); setError(message); }} />}
  </figure>;
}
