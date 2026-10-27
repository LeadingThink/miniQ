import { useRef, useState } from "react";
import { X } from "lucide-react";
import type { MessageAttachment, QueuedMessage } from "../types";
import { clipboardFiles } from "../clipboardFiles";
import { errorMessage } from "../errorMessage";
import { savePastedFile } from "../localFiles";
import { CopyButton } from "./CopyButton";
import { MessageAttachmentPreview } from "./MessageAttachmentPreview";
import type { QueueActions } from "./QueueBar";

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) || "pasted-file";
}

function attachmentsEqual(left: MessageAttachment[] = [], right: MessageAttachment[] = []): boolean {
  return left.length === right.length && left.every((attachment, index) => {
    const other = right[index];
    return attachment.path === other.path && attachment.name === other.name && attachment.mimeType === other.mimeType;
  });
}

export function QueueEditor({
  original,
  current,
  onUpdate,
  onClose,
}: {
  original: QueuedMessage;
  current?: QueuedMessage;
  onUpdate: QueueActions["onUpdate"];
  onClose: () => void;
}) {
  const [base, setBase] = useState(original);
  const [content, setContent] = useState(original.content);
  const [attachments, setAttachments] = useState<MessageAttachment[]>(original.attachments ?? []);
  const [attaching, setAttaching] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const changedElsewhere = !!current && (
    current.content !== base.content || !attachmentsEqual(current.attachments, base.attachments)
  );
  const valid = !!content.trim() || attachments.length > 0;
  const canSave = !!current && !changedElsewhere && valid && !pending && !attaching;

  async function pasteFiles(files: File[]) {
    if (files.length === 0 || attaching || pending) return;
    setAttaching(true);
    setError(null);
    try {
      const saved = await Promise.all(files.map(async (file) => {
        const path = await savePastedFile(file);
        return { path, name: file.name || fileName(path), ...(file.type ? { mimeType: file.type } : {}) };
      }));
      setAttachments((currentAttachments) => {
        const paths = new Set(currentAttachments.map((attachment) => attachment.path));
        return [...currentAttachments, ...saved.filter((attachment) => !paths.has(attachment.path))];
      });
    } catch (cause) {
      setError(`无法粘贴文件: ${errorMessage(cause)}`);
    } finally {
      setAttaching(false);
    }
  }

  async function save() {
    if (!canSave || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await onUpdate(base, content, attachments);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <form
      className="queue-editor"
      aria-label="编辑排队消息"
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label>
        编辑排队消息
        <textarea
          autoFocus
          rows={4}
          value={content}
          disabled={pending}
          onChange={(event) => setContent(event.target.value)}
          onPaste={(event) => {
            const files = clipboardFiles(event.clipboardData);
            if (files.length === 0) return;
            event.preventDefault();
            void pasteFiles(files);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            } else if (event.key === "Escape" && !inFlight.current) {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }}
        />
      </label>
      {!!attachments.length && (
        <div className="queue-attachments" aria-label="排队消息附件">
          {attachments.map((attachment) => (
            <span className="queue-editor-attachment" key={attachment.path}>
              <MessageAttachmentPreview attachment={attachment} />
              <button
                type="button"
                className="attach-remove"
                aria-label={`移除附件 ${attachment.name}`}
                title={`移除附件 ${attachment.name}`}
                disabled={pending}
                onClick={() => setAttachments((items) => items.filter((item) => item.path !== attachment.path))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {!current && (
        <div role="status">
          这条消息已开始执行或已被移除。编辑内容仍保留，可复制后重新发送。
        </div>
      )}
      {changedElsewhere && (
        <div role="status">
          这条消息已在其他设备更新。你的编辑内容仍保留，请先复制需要保留的部分。
          <button
            type="button"
            className="ghost"
            disabled={pending}
            onClick={() => {
              setBase(current);
              setContent(current.content);
              setAttachments(current.attachments ?? []);
              setError(null);
            }}
          >
            载入最新内容
          </button>
        </div>
      )}
      {error && (
        <div className="queue-error" role="alert">
          {error}
        </div>
      )}
      <div className="queue-editor-actions">
        <span className="queue-editor-hint">保存后保持原排队顺序</span>
        <CopyButton content={content} label="复制编辑内容" />
        <button
          type="button"
          className="ghost"
          disabled={pending}
          onClick={onClose}
        >
          取消
        </button>
        <button type="submit" disabled={!canSave}>
          {attaching ? "正在添加附件…" : pending ? "保存中…" : "保存"}
        </button>
      </div>
    </form>
  );
}
