import { useEffect, useState } from "react";
import type { MessageAttachment } from "../types";
import { readImagePreview } from "../localFiles";
import { useSessionFileAccess } from "../sessionFileAccess";

export function MessageAttachmentPreview({
  attachment,
}: {
  attachment: MessageAttachment;
}) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const access = useSessionFileAccess();
  const isImage = Boolean(attachment.mimeType?.startsWith("image/"));

  useEffect(() => {
    if (!isImage) return;
    let disposed = false;
    let objectUrl: string | undefined;
    const controller = new AbortController();
    void readImagePreview(attachment.path, { ...access, signal: controller.signal })
      .then((preview) => {
        if (!disposed) {
          if (preview.blob) objectUrl = URL.createObjectURL(preview.blob);
          setImageUrl(objectUrl ?? `data:${preview.mimeType};base64,${preview.dataBase64}`);
        }
      })
      .catch(() => {
        if (!disposed) setImageUrl(null);
      });
    return () => {
      disposed = true;
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
      />
    );
  }
  return <span className="message-attachment-file">{attachment.name}</span>;
}
