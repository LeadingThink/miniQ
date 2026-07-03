import { useState } from "react";

export function Composer(props: {
  busy: boolean;
  onSend: (content: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState("");

  const send = () => {
    const content = draft.trim();
    if (!content || props.busy) return;
    props.onSend(content);
    setDraft("");
  };

  return (
    <div className="composer">
      <textarea
        value={draft}
        placeholder={props.busy ? "Agent is working..." : "Ask miniQ... (Enter to send)"}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      {props.busy ? (
        <button className="danger" onClick={props.onCancel}>
          Cancel
        </button>
      ) : (
        <button onClick={send} disabled={!draft.trim()}>
          Send
        </button>
      )}
    </div>
  );
}
