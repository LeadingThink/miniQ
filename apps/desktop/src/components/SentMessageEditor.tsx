import { Clipboard } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import { charCount, sentMessageSegments } from "../largePaste";
import { PasteEditor } from "./PasteEditor";

export function SentMessageEditor(props: {
  content: string;
  onChange: (content: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  const initial = sentMessageSegments(props.content);
  const initialPaste = initial.find((segment) => segment.kind === "paste");
  const initialText = initial.filter((segment) => segment.kind === "text").map((segment) => segment.text).join("\n");
  const [paste, setPaste] = useState(initialPaste?.text ?? null);
  const [text, setText] = useState(initialPaste ? initialText : props.content);
  const [editingPaste, setEditingPaste] = useState(false);

  const update = (nextPaste: string | null, nextText: string) => {
    setPaste(nextPaste);
    setText(nextText);
    props.onChange([nextPaste, nextText].filter(Boolean).join("\n"));
  };

  if (initialPaste === undefined) {
    return (
      <textarea
        className="message-edit-input"
        aria-label="修改消息内容"
        value={text}
        autoFocus
        rows={Math.max(2, text.split("\n").length)}
        onChange={(event) => update(null, event.target.value)}
        onKeyDown={props.onKeyDown}
      />
    );
  }

  const label = paste === null ? null : `粘贴内容 ${charCount(paste)} 字`;
  return (
    <>
      <div className="message-edit-composer">
        {paste !== null && label && (
          <span className="paste-chip" title={`点击展开${label}`}>
            <button
              type="button"
              className="paste-chip-open"
              aria-label={`展开${label}`}
              aria-haspopup="dialog"
              onClick={() => setEditingPaste(true)}
            >
              <Clipboard size={12} aria-hidden="true" />
              <span className="paste-chip-label">{label}</span>
            </button>
            <button
              type="button"
              className="paste-chip-remove"
              aria-label={`移除${label}`}
              onClick={() => update(null, text)}
            >
              ×
            </button>
          </span>
        )}
        <textarea
          aria-label="修改消息内容"
          value={text}
          autoFocus
          rows={1}
          onChange={(event) => update(paste, event.target.value)}
          onKeyDown={props.onKeyDown}
        />
      </div>
      {editingPaste && paste !== null && (
        <PasteEditor
          paste={{ placeholder: "", text: paste }}
          readOnly={false}
          onClose={() => setEditingPaste(false)}
          onSave={(nextPaste) => {
            update(nextPaste, text);
            setEditingPaste(false);
          }}
        />
      )}
    </>
  );
}