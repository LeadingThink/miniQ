import { Code2 } from "lucide-react";
import { useRef, useState } from "react";
import type { ExternalEditor, ExternalEditorTarget } from "../externalEditor";
import { openInEditor } from "../externalEditor";
import { DropdownMenu } from "./DropdownMenu";

const EDITORS: Array<{ id: ExternalEditor; label: string }> = [
  { id: "vscode", label: "VS Code" },
  { id: "cursor", label: "Cursor" },
  { id: "zed", label: "Zed" },
];

/** Compact editor chooser shared by file previews and future diff views. */
export function ExternalEditorMenu(props: {
  target: ExternalEditorTarget;
  onError?: (message: string) => void;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const run = async (editor: ExternalEditor) => {
    setOpen(false);
    triggerRef.current?.focus();
    try {
      await openInEditor(props.target, editor);
    } catch (cause) {
      props.onError?.(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="icon-button"
        title="在外部编辑器中打开"
        aria-label="在外部编辑器中打开"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={!props.target.path.trim()}
        onClick={() => setOpen((value) => !value)}
      >
        <Code2 size={16} />
      </button>
      <DropdownMenu
        triggerRef={triggerRef}
        open={open}
        onClose={() => setOpen(false)}
      >
        {EDITORS.map((editor) => (
          <button
            key={editor.id}
            type="button"
            className="dropdown-item"
            onClick={() => void run(editor.id)}
          >
            <Code2 size={14} />
            <span>用 {editor.label} 打开</span>
          </button>
        ))}
      </DropdownMenu>
    </>
  );
}
