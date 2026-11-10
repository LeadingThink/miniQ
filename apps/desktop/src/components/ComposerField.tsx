import { Clipboard, FileText } from "lucide-react";
import type { ClipboardEvent, FormEvent, KeyboardEvent, RefObject } from "react";
import { useState } from "react";
import { draftSegments } from "../largePaste";
import type { PendingPaste } from "../largePaste";
import { PasteEditor } from "./PasteEditor";

/** One inline editor: plain text stays in textareas, a long paste becomes a chip. */
export function ComposerField(props: {
  fieldRef: RefObject<HTMLDivElement | null>;
  draft: string;
  pastes: readonly PendingPaste[];
  readOnly: boolean;
  autoFocus?: boolean;
  placeholder: string;
  describedBy: string;
  enterKeyHint?: "send" | "enter";
  inputAttributes: Record<string, unknown>;
  onSelect: (event: React.SyntheticEvent<HTMLTextAreaElement>) => void;
  onBlur: () => void;
  onBeforeInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onChange: (event: FormEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onRemovePaste: (placeholder: string) => void;
  onUpdatePaste: (placeholder: string, text: string) => void;
}) {
  const [editing, setEditing] = useState<PendingPaste | null>(null);
  const segments = draftSegments(props.draft, props.pastes);
  const chipped = segments.some((segment) => segment.kind === "paste");
  const startsWithPaste = chipped && segments[0]?.kind === "paste";
  let textIndex = 0;
  return (
    <>
      <div
        ref={props.fieldRef}
        className={`composer-field${chipped ? " has-paste" : ""}${startsWithPaste ? " starts-with-paste" : ""}`}
      >
        {segments.map((segment, segmentIndex) => {
          if (segment.kind === "paste") {
            const label = segment.paste.label ?? segment.paste.placeholder.slice(1, -1);
            const Icon = segment.paste.kind === "file-selection" ? FileText : Clipboard;
            return (
              <span
                key={segment.paste.placeholder}
                className="paste-chip"
                data-placeholder={segment.paste.placeholder}
                title={`点击展开${label}`}
              >
                <button
                  type="button"
                  className="paste-chip-open"
                  aria-label={`展开${label}`}
                  aria-haspopup="dialog"
                  onClick={() => setEditing(segment.paste)}
                >
                  <Icon size={12} aria-hidden="true" />
                  <span className="paste-chip-label">{label}</span>
                </button>
                <button
                  type="button"
                  className="paste-chip-remove"
                  aria-label={`移除${label}`}
                  disabled={props.readOnly}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => props.onRemovePaste(segment.paste.placeholder)}
                >
                  ×
                </button>
              </span>
            );
          }
          const index = textIndex;
          textIndex += 1;
          const only = !chipped;
          const beforePaste = segments.slice(segmentIndex + 1).some((next) => next.kind === "paste");
          return (
            <textarea
              key={`text-${index}`}
              className={`composer-segment${beforePaste ? " is-before-paste" : ""}`}
              readOnly={props.readOnly}
              aria-label={index === 0 ? "消息" : undefined}
              aria-describedby={index === 0 ? props.describedBy : undefined}
              value={segment.text}
              autoFocus={props.autoFocus && index === 0}
              placeholder={only ? props.placeholder : undefined}
              rows={1}
              enterKeyHint={props.enterKeyHint}
              {...(index === 0 ? props.inputAttributes : {})}
              onSelect={props.onSelect}
              onBlur={props.onBlur}
              onBeforeInput={props.onBeforeInput}
              onPaste={props.onPaste}
              onChange={props.onChange}
              onKeyDown={props.onKeyDown}
            />
          );
        })}
      </div>
      {editing && props.pastes.some((paste) => paste.placeholder === editing.placeholder) && (
        <PasteEditor
          paste={editing}
          readOnly={props.readOnly}
          onClose={() => setEditing(null)}
          onSave={(text) => {
            props.onUpdatePaste(editing.placeholder, text);
            setEditing(null);
          }}
        />
      )}
    </>
  );
}
