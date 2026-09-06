import { Download, Maximize, Minimize, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { loadObservation, observationImage } from "../computerObservation";
import type { RpcClient } from "../rpc";
import type { ToolCall } from "../types";
import "./ComputerObservation.css";

export function ComputerObservation({ call, client }: { call: ToolCall; client: RpcClient }) {
  const image = observationImage(call);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [original, setOriginal] = useState(false);
  useEffect(() => {
    if (!image) return;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setUrl(null);
    setError(null);
    void loadObservation(client, call, controller.signal).then(blob => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(String(cause));
    });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [client, call.id, call.sessionId, image?.id, attempt]);
  if (!image) return null;
  return <figure className="computer-observation">
    <figcaption>
      <strong>{call.toolName === "computer_use" ? "桌面观察" : "浏览器观察"}</strong>
      <span className="observation-size">{image.width} × {image.height}</span>
      <div className="observation-actions" role="toolbar" aria-label="截图操作">
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
        ? <img src={url} alt={call.toolName === "computer_use" ? "操作后的桌面截图" : "操作后的网页截图"} width={image.width} height={image.height} onError={() => setError("截图无法显示，请重新加载")} />
        : <div role="status">正在加载截图</div>}
    </div>
  </figure>;
}
