import { MessageSquare, X } from "lucide-react";
import "./PreviewSelection.css";

export function PreviewSelection({
  text,
  onDiscuss,
  onClear,
}: {
  text: string;
  onDiscuss: () => void;
  onClear: () => void;
}) {
  if (!text) return null;
  return (
    <section className="preview-selection" aria-label="选中的文件内容">
      <div>
        <strong>针对选中内容提问</strong>
        <small>仅加入输入框，确认后发送</small>
        <button
          type="button"
          className="icon-button"
          title="清除选区"
          aria-label="清除选区"
          onClick={onClear}
        >
          <X size={14} />
        </button>
      </div>
      <blockquote>{text}</blockquote>
      <button type="button" className="ghost" onClick={onDiscuss}>
        <MessageSquare size={14} /> 加入提问
      </button>
    </section>
  );
}
