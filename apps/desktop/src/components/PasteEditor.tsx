import { useState } from "react";
import { charCount, type PendingPaste } from "../largePaste";
import { Dialog } from "./ui/Dialog";
import "./PasteEditor.css";

/** Full-text editing stays local until the user explicitly saves. */
export function PasteEditor(props: {
  paste: PendingPaste;
  readOnly: boolean;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(props.paste.text);
  return (
    <Dialog
      open
      title={props.paste.kind === "file-selection" ? "查看和编辑引用内容" : "查看和编辑粘贴内容"}
      description="保存后将使用修改后的全文发送；取消不会改变原内容。"
      className="paste-editor"
      onClose={props.onClose}
      footer={
        <>
          <span className="paste-editor-count" role="status">{charCount(text)} 字</span>
          <button type="button" className="secondary" onClick={props.onClose}>取消</button>
          <button type="button" disabled={props.readOnly} onClick={() => props.onSave(text)}>保存修改</button>
        </>
      }
    >
      <textarea
        data-autofocus
        aria-label="完整文本"
        value={text}
        readOnly={props.readOnly}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) event.stopPropagation();
        }}
      />
    </Dialog>
  );
}