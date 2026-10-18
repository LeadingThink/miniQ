import type { RemotePreviewSource } from "../remoteTransfer";
import { useEffect, useRef, useState } from "react";
import type { MessageAttachment } from "../types";
import { readImagePreview } from "../localFiles";
import { useSessionFileAccess } from "../sessionFileAccess";

export function MessageAttachmentPreview({
  attachment,
}: {
  attachment: MessageAttachment;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const source = useRef<RemotePreviewSource | null>(null);
  const generation = useRef(0);
  const access = useSessionFileAccess();
  const isImage = Boolean(attachment.mimeType?.startsWith("image/"));

  useEffect(() => {
    if (!isImage) return;
    const id = ++generation.current;
    source.current = null;
    setImageUrl(null);
    let disposed = false;
    let objectUrl: string | undefined;
    const controller = new AbortController();
    void readImagePreview(attachment.path, { ...access, signal: controller.signal })
      .then((preview) => {
        if (!disposed) {
          if (preview.blob) objectUrl = URL.createObjectURL(preview.blob);
          source.current = preview.remoteSource ?? null;
          setImageUrl(preview.remoteSource?.getUrl ?? objectUrl ?? `data:${preview.mimeType};base64,${preview.dataBase64}`);
        }
      })
      .catch(() => {
        if (!disposed) setImageUrl(null);
      });
    return () => {
      disposed = true;
      if (generation.current === id) generation.current++;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.path, isImage, access]);

  if (imageUrl) {
    return (
      <img
        className="message-attachment-image"
        src={imageUrl}
        alt={attachment.name}
        referrerPolicy="no-referrer"
        onError={() => {
          const current = source.current;
          const id = generation.current;
          if (!current) { setImageUrl(null); return; }
          source.current = null;
          void current.refresh().then(next => {
            if (generation.current === id) { source.current = next; setImageUrl(next.getUrl); }
          }).catch(() => { if (generation.current === id) setImageUrl(null); });
        }}
      />
    );
  }
  return <span className="message-attachment-file">{attachment.name}</span>;
}
