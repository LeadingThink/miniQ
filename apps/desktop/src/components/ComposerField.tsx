import { Clipboard } from "lucide-react";
import type { ClipboardEvent, FormEvent, KeyboardEvent, RefObject } from "react";
import { draftSegments } from "../largePaste";
import type { PendingPaste } from "../largePaste";

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
}) {
  const segments = draftSegments(props.draft, props.pastes);
  const chipped = segments.some((segment) => segment.kind === "paste");
  let textIndex = 0;
  return (
    <div
      ref={props.fieldRef}
      className={`composer-field${chipped ? " has-paste" : ""}`}
    >
      {segments.map((segment) => {
        if (segment.kind === "paste") {
          const label = segment.paste.placeholder.slice(1, -1);
          return (
            <span
              key={segment.paste.placeholder}
              className="paste-chip"
              data-placeholder={segment.paste.placeholder}
              title={segment.paste.placeholder}
            >
              <Clipboard size={12} aria-hidden="true" />
              <span className="paste-chip-label">{label}</span>
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
        return (
          <textarea
            key={`text-${index}`}
            className="composer-segment"
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
  );
}
