import { useEffect, useId, useState } from "react";
import { CopyButton } from "./CopyButton";
import { Maximize, ZoomIn, ZoomOut } from "lucide-react";

let renderer: Promise<(typeof import("mermaid"))["default"]> | undefined;
function loadRenderer() {
  renderer ??= import("mermaid")
    .then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "default",
        suppressErrorRendering: true,
      });
      return mermaid;
    })
    .catch((error) => {
      renderer = undefined;
      throw error;
    });
  return renderer;
}

export function MermaidPreview({ source }: { source: string }) {
  const id = `diagram${useId().replace(/[^a-z\d]/gi, "")}`;
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setUrl(null);
    setError(null);
    void loadRenderer()
      .then(async (mermaid) => {
        if (cancelled) return;
        const { svg } = await mermaid.render(id, source);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(
          new Blob([svg], { type: "image/svg+xml" }),
        );
        setUrl(objectUrl);
      })
      .catch((cause) => {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, source]);
  return (
    <div className="mermaid-preview">
      {url && (
        <>
          <div className="mermaid-viewport">
            <img
              src={url}
              alt="Mermaid 图表"
              style={{ width: `${zoom * 100}%` }}
            />
          </div>
          <div className="mermaid-controls" role="group" aria-label="图表缩放">
            <button
              type="button"
              className="icon-button"
              title="缩小图表"
              aria-label="缩小图表"
              disabled={zoom <= 1}
              onClick={() => setZoom((value) => value - 0.5)}
            >
              <ZoomOut size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="放大图表"
              aria-label="放大图表"
              disabled={zoom >= 4}
              onClick={() => setZoom((value) => value + 0.5)}
            >
              <ZoomIn size={15} />
            </button>
            <button
              type="button"
              className="icon-button"
              title="适配图表"
              aria-label="适配图表"
              onClick={() => setZoom(1)}
            >
              <Maximize size={15} />
            </button>
            <CopyButton content={source} label="复制图表源码" />
          </div>
        </>
      )}
      {!url && !error && <div role="status">正在绘制图表...</div>}
      {error && <div role="alert">图表解析失败：{error}</div>}
      <details open={Boolean(error)}>
        <summary>Mermaid</summary>
        <pre>
          <code>{source}</code>
        </pre>
      </details>
    </div>
  );
}
