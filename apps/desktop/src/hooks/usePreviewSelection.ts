import { useEffect, useRef, useState } from "react";

export interface PreviewSelectionAnchor {
  x: number;
  y: number;
}

export interface PreviewSelectionValue {
  text: string;
  startLine: number;
  endLine: number;
}

function lineAt(container: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(container);
  range.setEnd(node, offset);
  return range.toString().split("\n").length;
}

/** Keep a deliberate selection while toolbar focus moves; never use another panel's text. */
export function usePreviewSelection(path: string, revision?: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState<{
    path: string;
    text: string;
    anchor: PreviewSelectionAnchor;
    startLine: number;
    endLine: number;
  } | null>(null);
  useEffect(() => {
    setValue(null);
    const capture = () => {
      const selection = window.getSelection();
      const text = selection?.toString() ?? "";
      if (!selection || selection.isCollapsed || !text.trim()) return;
      if (
        !ref.current?.contains(selection.anchorNode) ||
        !ref.current.contains(selection.focusNode)
      ) {
        setValue(null);
        return;
      }
      const range = selection.getRangeAt(0);
      const rects = range.getClientRects?.();
      const rect = rects && rects.length > 0
        ? rects[rects.length - 1]
        : range.getBoundingClientRect();
      const container = ref.current;
      const startLine = lineAt(container, range.startContainer, range.startOffset);
      const endLine = lineAt(container, range.endContainer, range.endOffset);
      setValue({ path, text, anchor: { x: rect.left, y: rect.top }, startLine, endLine });
    };
    document.addEventListener("selectionchange", capture);
    return () => document.removeEventListener("selectionchange", capture);
  }, [path, revision]);
  return {
    ref,
    text: value?.path === path ? value.text : "",
    anchor: value?.path === path ? value.anchor : null,
    startLine: value?.path === path ? value.startLine : null,
    endLine: value?.path === path ? value.endLine : null,
    setText: (selection: PreviewSelectionValue, anchor: PreviewSelectionAnchor) =>
      setValue(selection.text.trim() ? { path, ...selection, anchor } : null),
    clear: () => setValue(null),
  };
}
