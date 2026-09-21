import { useEffect, useRef, useState } from "react";
import { Paperclip, X } from "lucide-react";
import { readImagePreview } from "../localFiles";

function fileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
}

function isImageAttachment(path: string): boolean {
  return /\.(?:png|jpe?g|webp|gif)$/i.test(path);
}

export function AttachmentPreview(props: {
  path: string;
  sending: boolean;
  onRemove: () => void;
  remote?: boolean;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const previewRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!zoomed) return;
    const closeWhenOutside = (event: PointerEvent) => {
      if (!previewRef.current?.contains(event.target as Node)) setZoomed(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoomed(false);
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [zoomed]);

  useEffect(() => {
    if (props.remote || !isImageAttachment(props.path)) return;
    let disposed = false;
    void readImagePreview(props.path)
      .then((preview) => {
        if (!disposed)
          setImageUrl(`data:${preview.mimeType};base64,${preview.dataBase64}`);
      })
      .catch(() => {
        if (!disposed) setImageUrl(null);
      });
    return () => {
      disposed = true;
    };
  }, [props.path, props.remote]);

  if (imageUrl) {
    return (
      <span
        ref={previewRef}
        className={`attach-image-chip${zoomed ? " zoomed" : ""}`}
        title={props.path}
        onClick={() => setZoomed((current) => !current)}
      >
        <img
          src={imageUrl}
          alt={fileName(props.path)}
          className="attach-image-preview"
        />
        <button
          type="button"
          className="attach-remove attach-image-remove"
          title={`移除图片 ${fileName(props.path)}`}
          aria-label={`移除图片 ${fileName(props.path)}`}
          disabled={props.sending}
          onClick={(event) => {
            event.stopPropagation();
            props.onRemove();
          }}
        >
          <X size={12} />
        </button>
      </span>
    );
  }

  return (
    <span className="attach-chip" title={props.path}>
      <Paperclip size={12} />
      <span className="attach-file-name">{fileName(props.path)}</span>
      <button
        type="button"
        className="attach-remove"
        title={`移除附件 ${fileName(props.path)}`}
        aria-label={`移除附件 ${fileName(props.path)}`}
        disabled={props.sending}
        onClick={props.onRemove}
      >
        <X size={11} />
      </button>
    </span>
  );
}
