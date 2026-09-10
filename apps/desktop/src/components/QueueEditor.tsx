import { useRef, useState } from "react";
import type { QueuedMessage } from "../types";
import { errorMessage } from "../errorMessage";
import { CopyButton } from "./CopyButton";
import type { QueueActions } from "./QueueBar";

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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const changedElsewhere = !!current && current.content !== base.content;
  const valid = !!content.trim() || !!base.attachments?.length;
  const canSave = !!current && !changedElsewhere && valid && !pending;

  async function save() {
    if (!canSave || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await onUpdate(base, content);
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
      {!!base.attachments?.length && (
        <div className="queue-attachments">
          保留附件：{base.attachments.map((file) => file.name).join("、")}
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
          {pending ? "保存中…" : "保存"}
        </button>
      </div>
    </form>
  );
}
