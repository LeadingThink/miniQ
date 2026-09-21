import { Maximize, Scan, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { decodeBase64 } from "../previewBinary";
import "./MediaPreview.css";
import {
  usePreviewCache,
  usePreviewScroll,
  usePreviewValue,
} from "../previewViewState";

type Props = {
  dataBase64: string;
  mimeType: string;
  kind: "image" | "audio" | "video";
  label: string;
  onError: (message: string) => void;
};

export function BlobPreview({ dataBase64, mimeType, ...props }: Props) {
  const onError = useRef(props.onError);
  onError.current = props.onError;
  const [source, setSource] = useState<{
    data: string;
    mime: string;
    url: string;
    fallbackUrl?: string;
  } | null>(null);
  const [useFallback, setUseFallback] = useState(false);
  useEffect(() => {
    let url: string | undefined;
    try {
      const bytes = decodeBase64(dataBase64);
      url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
      // Some embedded WebViews (including iOS WKWebView) occasionally fail
      // to hand a blob: URL to the media decoder for remote files. Keep a
      // data URL fallback ready for medium-sized assets on every platform;
      // larger files still use the memory-efficient blob URL only.
      const fallbackUrl = bytes.byteLength <= 16 * 1024 * 1024
        ? `data:${mimeType};base64,${dataBase64}`
        : undefined;
      setUseFallback(false);
      setSource({ data: dataBase64, mime: mimeType, url, fallbackUrl });
    } catch (error) {
      setSource(null);
      onError.current(error instanceof Error ? error.message : String(error));
    }
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [dataBase64, mimeType]);
  if (!source || source.data !== dataBase64 || source.mime !== mimeType) {
    return <div className="diff-empty">正在读取媒体...</div>;
  }
  const sourceUrl = useFallback && source.fallbackUrl ? source.fallbackUrl : source.url;
  const retryWithFallback = () => {
    if (source.fallbackUrl && !useFallback) {
      setUseFallback(true);
      return;
    }
    props.onError(props.kind === "image" ? "图片解码失败" : props.kind === "video" ? "视频解码失败" : "音频解码失败");
  };
  return props.kind === "image" ? (
    <ImageInspector
      key={sourceUrl}
      url={sourceUrl}
      label={props.label}
      onError={retryWithFallback}
    />
  ) : (
    <TimeMediaInspector key={sourceUrl} url={sourceUrl} {...props} onError={retryWithFallback} />
  );
}

export function ImageInspector({
  url,
  label,
  onError,
  intrinsicSize,
}: {
  url: string;
  label: string;
  onError: Props["onError"];
  intrinsicSize?: { width: number; height: number };
}) {
  const [mode, setMode] = usePreviewValue<"fit" | "zoom">("imageMode", "fit");
  const [zoom, setZoom] = usePreviewValue("imageZoom", 100);
  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const scroll = usePreviewScroll<HTMLDivElement>("image", Boolean(dimensions));
  const updateZoom = (value: number) => {
    setZoom(Math.max(25, Math.min(400, value)));
    setMode("zoom");
  };
  return (
    <div className="media-inspector">
      <div
        className="media-inspector-controls"
        role="group"
        aria-label="图片显示"
      >
        <button
          type="button"
          className="icon-button"
          aria-label="适配图片"
          title="适配图片"
          aria-pressed={mode === "fit"}
          onClick={() => setMode("fit")}
        >
          <Maximize size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="图片原始尺寸"
          title="图片原始尺寸"
          aria-pressed={mode === "zoom" && zoom === 100}
          onClick={() => updateZoom(100)}
        >
          <Scan size={16} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="缩小图片"
          title="缩小图片"
          disabled={!dimensions || (mode === "zoom" && zoom === 25)}
          onClick={() => updateZoom(zoom - 25)}
        >
          <ZoomOut size={16} />
        </button>
        <input
          type="range"
          aria-label="图片缩放比例"
          min={25}
          max={400}
          step={25}
          value={zoom}
          disabled={!dimensions}
          onChange={(event) => updateZoom(Number(event.target.value))}
        />
        <button
          type="button"
          className="icon-button"
          aria-label="放大图片"
          title="放大图片"
          disabled={!dimensions || (mode === "zoom" && zoom === 400)}
          onClick={() => updateZoom(zoom + 25)}
        >
          <ZoomIn size={16} />
        </button>
        <output>{mode === "fit" ? "适配" : `${zoom}%`}</output>
        {dimensions && (
          <span>
            {dimensions.width} × {dimensions.height} px
          </span>
        )}
      </div>
      <div
        {...scroll}
        className={`image-inspector-viewport ${mode}`}
        data-pinch-zoom="true"
        tabIndex={0}
        aria-label="图片画布"
      >
        <img
          src={url}
          alt={label || "图片预览"}
          style={
            mode === "zoom" && dimensions
              ? {
                  width: (dimensions.width * zoom) / 100,
                  height: (dimensions.height * zoom) / 100,
                }
              : undefined
          }
          onLoad={(event) =>
            setDimensions(
              intrinsicSize ?? {
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              },
            )
          }
          onError={() => onError("图片解码失败")}
        />
      </div>
    </div>
  );
}

function TimeMediaInspector({
  url,
  kind,
  label,
  onError,
}: {
  url: string;
  kind: Props["kind"];
  label: string;
  onError: Props["onError"];
}) {
  const [metadata, setMetadata] = useState("");
  const viewCache = usePreviewCache();
  const elementProps = {
    src: url,
    controls: true,
    preload: "metadata",
    "aria-label": label || (kind === "video" ? "视频预览" : "音频预览"),
    onLoadedMetadata: (event: React.SyntheticEvent<HTMLMediaElement>) => {
      const media = event.currentTarget;
      const savedTime = viewCache.get("mediaTime");
      if (typeof savedTime === "number" && Number.isFinite(media.duration))
        media.currentTime = Math.min(savedTime, media.duration);
      const duration = Number.isFinite(media.duration)
        ? `${media.duration.toFixed(1)} 秒`
        : "";
      setMetadata(
        media instanceof HTMLVideoElement
          ? `${media.videoWidth} × ${media.videoHeight} px · ${duration}`
          : duration,
      );
    },
    onTimeUpdate: (event: React.SyntheticEvent<HTMLMediaElement>) =>
      viewCache.set("mediaTime", event.currentTarget.currentTime),
    onError: () => onError(kind === "video" ? "视频解码失败" : "音频解码失败"),
  };
  return (
    <div className="media-inspector">
      {metadata && (
        <div className="media-inspector-controls">
          <span>{metadata}</span>
        </div>
      )}
      <div className="media-preview">
        {kind === "video" ? (
          <video {...elementProps} playsInline />
        ) : (
          <audio {...elementProps} />
        )}
      </div>
    </div>
  );
}
