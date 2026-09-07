import { FileWarning } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { decodeBase64 } from "../previewBinary";
export { PdfPreview } from "./PdfPreview";
export { SpreadsheetPreview } from "./SpreadsheetPreview";

export function BlobPreview(props: {
  dataBase64: string;
  mimeType: string;
  kind: "image" | "audio" | "video";
  label: string;
  onError: (message: string) => void;
}) {
  const url = useMemo(() => {
    const blob = new Blob([decodeBase64(props.dataBase64)], {
      type: props.mimeType,
    });
    return URL.createObjectURL(blob);
  }, [props.dataBase64, props.mimeType]);

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  if (props.kind === "image") {
    return (
      <div className="media-preview">
        <img src={url} alt={props.label || "图片预览"} onError={() => props.onError("图片解码失败")} />
      </div>
    );
  }
  if (props.kind === "audio") {
    return (
      <div className="media-preview">
        <audio src={url} controls preload="metadata" onError={() => props.onError("音频解码失败")} />
      </div>
    );
  }
  return (
    <div className="media-preview">
      <video src={url} controls preload="metadata" onError={() => props.onError("视频解码失败")} />
    </div>
  );
}

export function DocxPreview(props: { dataBase64: string; onError: (message: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "document-loading";
    loading.textContent = "正在解析 Word 文档...";
    container.append(loading);
    void import("docx-preview")
      .then(({ renderAsync }) => {
        if (cancelled) return;
        container.replaceChildren();
        return renderAsync(decodeBase64(props.dataBase64), container, undefined, {
          breakPages: true,
          ignoreLastRenderedPageBreak: false,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          useBase64URL: true,
        });
      })
      .catch((cause) => {
        if (!cancelled) {
          container.replaceChildren();
          props.onError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [props.dataBase64, props.onError]);

  return <div ref={containerRef} className="office-preview docx-preview" />;
}

export function PptxPreview(props: { dataBase64: string; onError: (message: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "document-loading";
    loading.textContent = "正在解析演示文稿...";
    container.append(loading);
    void import("pptx-preview")
      .then(({ init }) => {
        if (cancelled) return;
        container.replaceChildren();
        return init(container, {
          width: 960,
          height: 540,
          mode: "list",
        }).preview(decodeBase64(props.dataBase64));
      })
      .catch((cause) => {
        if (!cancelled) {
          container.replaceChildren();
          props.onError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [props.dataBase64, props.onError]);

  return <div ref={containerRef} className="office-preview pptx-preview" />;
}

export function UnsupportedPreview() {
  return (
    <div className="unsupported-preview">
      <FileWarning size={32} />
      <strong>暂不支持内嵌预览此格式</strong>
      <span>可以使用右上角按钮在系统默认应用中打开。</span>
    </div>
  );
}
