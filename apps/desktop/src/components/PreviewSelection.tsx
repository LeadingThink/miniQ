import { MessageSquare } from "lucide-react";
import { useRef } from "react";
import { createPortal } from "react-dom";
import type { PreviewSelectionAnchor } from "../hooks/usePreviewSelection";
import { useAnchoredPosition } from "./ui/useAnchoredPosition";
import "./PreviewSelection.css";

export function PreviewSelection({
  visible,
  anchor,
  onDiscuss,
  onClear,
}: {
  visible: boolean;
  anchor: PreviewSelectionAnchor | null;
  onDiscuss: () => void;
  onClear: () => void;
}) {
  const floatingRef = useRef<HTMLButtonElement>(null);
  const unusedAnchorRef = useRef<HTMLElement>(null);
  const position = useAnchoredPosition(
    unusedAnchorRef,
    floatingRef,
    Boolean(visible && anchor),
    anchor,
    8,
  );
  if (!visible || !anchor) return null;
  return createPortal(
    <button
      ref={floatingRef}
      type="button"
      className="preview-selection primary"
      onClick={onDiscuss}
      style={position ? {
        left: position.left,
        top: position.top,
        maxHeight: position.maxHeight,
      } : undefined}
      onBlur={onClear}
    >
      <MessageSquare size={14} /> 引用
    </button>,
    document.body,
  );
}
