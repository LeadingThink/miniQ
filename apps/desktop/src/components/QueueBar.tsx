import { ChevronDown, ChevronUp, FileText, Image as ImageIcon, Pencil, X, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { QueuedMessage } from "../types";
import { errorMessage } from "../errorMessage";
import { QueueEditor } from "./QueueEditor";
import "./QueueBar.css";

export interface QueueActions {
  onUpdate: (original: QueuedMessage, content: string) => Promise<void>;
  onSteer: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onMove?: (item: QueuedMessage, direction: "up" | "down") => Promise<void>;
}

const IMAGE_ATTACHMENT = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg|heic)$/i;

export function QueueBar({
  queue,
  ...actions
}: QueueActions & { queue: QueuedMessage[] }) {
  const [editing, setEditing] = useState<QueuedMessage | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const editTrigger = useRef<HTMLButtonElement | null>(null);
  const region = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!editing && editTrigger.current) {
      const target = editTrigger.current.isConnected
        ? editTrigger.current
        : region.current;
      target?.focus({ preventScroll: true });
      editTrigger.current = null;
    }
  }, [editing]);

  async function perform(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function move(item: QueuedMessage, direction: "up" | "down") {
    if (!actions.onMove || pending || editing) return;
    const index = queue.findIndex((queued) => queued.id === item.id);
    if (index < 0 || (direction === "up" ? index === 0 : index === queue.length - 1)) return;
    void perform(() => actions.onMove!(item, direction));
  }

  // Reordering only earns its two icons when another item can trade places.
  const reorderable = !!actions.onMove && queue.length > 1;

  // Nothing queued means nothing to dock: the bar only exists while a message
  // waits, or while its draft is still being edited so text cannot be lost.
  if (queue.length === 0 && !editing) return null;
  return (
    <section
      ref={region}
      tabIndex={-1}
      className="queue-bar"
      aria-label="排队消息"
      aria-busy={pending}
    >
      <div className="queue-head">
        <span className="queue-pill">
          <span className="queue-pill-dot" aria-hidden="true" />
          排队中 · {queue.length}
        </span>
        <span className="queue-hint">前序任务完成后自动执行</span>
      </div>
      <div className="queue-list">
        {queue.map((item, index) => (
          <div key={item.id} className="queue-item">
            <span className="queue-position">#{index + 1}</span>
            <div
              className="queue-content"
              tabIndex={0}
              title={reorderable ? `${item.content}\n\n按 Alt+↑/↓ 调整排队顺序` : item.content}
              onKeyDown={(event) => {
                if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
                event.preventDefault();
                move(item, event.key === "ArrowUp" ? "up" : "down");
              }}
            >
              {item.content}
            </div>
            {!!item.attachments?.length && (
              <div
                className="queue-attachments"
                title={item.attachments.map((file) => file.path).join("\n")}
              >
                {item.attachments.map((file) => (
                  <span key={file.path} className="queue-attachment">
                    {IMAGE_ATTACHMENT.test(file.name)
                      ? <ImageIcon size={11} aria-hidden="true" />
                      : <FileText size={11} aria-hidden="true" />}
                    <span className="queue-attachment-name">{file.name}</span>
                  </span>
                ))}
              </div>
            )}
            <div className="queue-actions">
              {reorderable && (
                <>
                  <button
                    type="button"
                    className="ghost"
                    disabled={pending || !!editing || index === 0}
                    aria-label={`上移第 ${index + 1} 条排队消息`}
                    aria-keyshortcuts="Alt+ArrowUp"
                    title={index === 0 ? "已经是第一条" : "上移（Alt+↑）"}
                    onClick={() => move(item, "up")}
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={pending || !!editing || index === queue.length - 1}
                    aria-label={`下移第 ${index + 1} 条排队消息`}
                    aria-keyshortcuts="Alt+ArrowDown"
                    title={index === queue.length - 1 ? "已经是最后一条" : "下移（Alt+↓）"}
                    onClick={() => move(item, "down")}
                  >
                    <ChevronDown size={13} />
                  </button>
                </>
              )}
              <button
                type="button"
                className="ghost"
                disabled={pending || !!editing}
                aria-label={`编辑第 ${index + 1} 条排队消息`}
                title="编辑这条消息"
                onClick={(event) => {
                  editTrigger.current = event.currentTarget;
                  setError(null);
                  setEditing(item);
                }}
              >
                <Pencil size={13} />
              </button>
              <button
                type="button"
                className="ghost queue-steer"
                disabled={pending || !!editing}
                aria-label="调整方向"
                title="调整方向：打断当前任务，立即执行这条消息"
                onClick={() => void perform(() => actions.onSteer(item.id))}
              >
                <Zap size={13} />
              </button>
              <button
                type="button"
                className="ghost queue-remove"
                disabled={pending || !!editing}
                aria-label={`移除第 ${index + 1} 条排队消息`}
                title="从队列移除"
                onClick={() => void perform(() => actions.onRemove(item.id))}
              >
                <X size={13} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {editing && (
        <QueueEditor
          original={editing}
          current={queue.find((item) => item.id === editing.id)}
          onUpdate={actions.onUpdate}
          onClose={() => setEditing(null)}
        />
      )}
      {error && (
        <div className="queue-error" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}
