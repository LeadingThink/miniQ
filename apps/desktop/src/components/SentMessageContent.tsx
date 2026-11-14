import { Clipboard } from "lucide-react";
import { useState } from "react";
import type { PastedTextContent } from "../types";
import { draftSegments, sentMessageSegments } from "../largePaste";
import { PasteEditor } from "./PasteEditor";

export function SentMessageContent(props: { content: string; pastedText?: PastedTextContent }) {
  const [openText, setOpenText] = useState<string | null>(null);
  const segments = props.pastedText
    ? draftSegments(props.pastedText.content, props.pastedText.pastes).map((segment) =>
        segment.kind === "text"
          ? segment
          : {
              kind: "paste" as const,
              text: segment.paste.text,
              label: segment.paste.label ?? segment.paste.placeholder.slice(1, -1),
            },
      )
    : sentMessageSegments(props.content);
  return (
    <>
      <div className="sent-message-content">
        {segments.map((segment, index) => segment.kind === "text" ? (
          <span key={`text-${index}`} className="sent-message-text">{segment.text}</span>
        ) : (
          <button
            key={`paste-${index}`}
            type="button"
            className="sent-paste-chip"
            aria-label={`查看${segment.label}`}
            aria-haspopup="dialog"
            onClick={() => setOpenText(segment.text)}
          >
            <Clipboard size={12} aria-hidden="true" />
            <span>{segment.label}</span>
          </button>
        ))}
      </div>
      {openText !== null && (
        <PasteEditor
          paste={{ placeholder: "", text: openText }}
          readOnly
          onClose={() => setOpenText(null)}
          onSave={() => undefined}
        />
      )}
    </>
  );
}