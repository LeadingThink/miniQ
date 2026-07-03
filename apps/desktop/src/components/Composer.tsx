import { useState } from "react";

/** Rounded composer card: textarea + context chip row + circular send. */
export function ComposerCard(props: {
  busy: boolean;
  placeholder: string;
  chip?: string;
  autoFocus?: boolean;
  onSend: (content: string) => void;
  onCancel?: () => void;
}) {
  const [draft, setDraft] = useState("");

  const send = () => {
    const content = draft.trim();
    if (!content || props.busy) return;
    props.onSend(content);
    setDraft("");
  };

  return (
    <div className="composer-card">
      <textarea
        value={draft}
        autoFocus={props.autoFocus}
        placeholder={props.busy ? "任务执行中..." : props.placeholder}
        rows={1}
        onChange={(e) => {
          setDraft(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="composer-row">
        {props.chip && <span className="chip">🗂 {props.chip}</span>}
        {props.busy && props.onCancel ? (
          <button className="send-btn stop" title="取消" onClick={props.onCancel}>
            ■
          </button>
        ) : (
          <button className="send-btn" title="发送" disabled={!draft.trim()} onClick={send}>
            ↑
          </button>
        )}
      </div>
    </div>
  );
}

/** Bottom-docked composer for an open session. */
export function Composer(props: {
  busy: boolean;
  chip?: string;
  onSend: (content: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="composer-outer">
      <ComposerCard
        busy={props.busy}
        placeholder="随心输入,Enter 发送"
        chip={props.chip}
        onSend={props.onSend}
        onCancel={props.onCancel}
      />
    </div>
  );
}
