import { useEffect, useState } from "react";
import { Paperclip, X } from "lucide-react";
import { readImagePreview } from "../localFiles";
import { ImageLightbox } from "./ImageLightbox";

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
  /** Open a non-image attachment in the existing file workbench. */
  onOpenAttachment?: (path: string) => void;
  remote?: boolean;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);

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
    const name = fileName(props.path);
    return (
      <span className="attach-image-chip" title={props.path}>
        <button
          type="button"
          className="attach-image-view"
          aria-label={`放大查看 ${name}`}
          onClick={() => setViewerOpen(true)}
        >
          <img src={imageUrl} alt={name} className="attach-image-preview" />
        </button>
        <button
          type="button"
          className="attach-remove attach-image-remove"
          title={`移除图片 ${name}`}
          aria-label={`移除图片 ${name}`}
          disabled={props.sending}
          onClick={(event) => {
            event.stopPropagation();
            props.onRemove();
          }}
        >
          <X size={12} />
        </button>
        <ImageLightbox
          open={viewerOpen}
          src={imageUrl}
          alt={name}
          onClose={() => setViewerOpen(false)}
        />
      </span>
    );
  }

  const name = fileName(props.path);
  return (
    <span className="attach-chip" title={props.path}>
      <button
        type="button"
        className="attach-file-open"
        aria-label={`打开附件 ${name}`}
        disabled={!props.onOpenAttachment}
        onClick={() => props.onOpenAttachment?.(props.path)}
      >
        <Paperclip size={12} />
        <span className="attach-file-name">{name}</span>
      </button>
      <button
        type="button"
        className="attach-remove"
        title={`移除附件 ${name}`}
        aria-label={`移除附件 ${name}`}
        disabled={props.sending}
        onClick={(event) => {
          event.stopPropagation();
          props.onRemove();
        }}
      >
        <X size={11} />
      </button>
    </span>
  );
}
