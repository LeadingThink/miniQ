import { Pencil, X, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { QueuedMessage } from "../types";
import { errorMessage } from "../errorMessage";
import { QueueEditor } from "./QueueEditor";

export interface QueueActions {
  onUpdate: (original: QueuedMessage, content: string) => Promise<void>;
  onSteer: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}

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

  if (queue.length === 0 && !editing && !error) return null;
  return (
    <section
      ref={region}
      tabIndex={-1}
      className="queue-bar"
      aria-label="排队消息"
      aria-busy={pending}
    >
      <div className="queue-title">
        已排队 {queue.length} 条，当前任务结束后依次执行
      </div>
      <div className="queue-list">
        {queue.map((item, index) => (
          <div key={item.id} className="queue-item">
            <div className="queue-content" tabIndex={0}>
              <span className="queue-position">{index + 1}.</span>{" "}
              {item.content}
              {!!item.attachments?.length && (
                <div
                  className="queue-attachments"
                  title={item.attachments.map((file) => file.path).join("\n")}
                >
                  附件：{item.attachments.map((file) => file.name).join("、")}
                </div>
              )}
            </div>
            <div className="queue-actions">
              <button
                type="button"
                className="ghost"
                disabled={pending || !!editing}
                aria-label={`编辑第 ${index + 1} 条排队消息`}
                onClick={(event) => {
                  editTrigger.current = event.currentTarget;
                  setError(null);
                  setEditing(item);
                }}
              >
                <Pencil size={13} /> 编辑
              </button>
              <button
                type="button"
                className="ghost queue-steer"
                disabled={pending || !!editing}
                title="调整方向：打断当前任务，立即执行这条消息"
                onClick={() => void perform(() => actions.onSteer(item.id))}
              >
                <Zap size={13} /> 调整方向
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
