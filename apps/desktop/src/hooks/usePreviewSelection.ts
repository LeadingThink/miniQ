import { useEffect, useRef, useState } from "react";

/** Keep a deliberate selection while toolbar focus moves; never use another panel's text. */
export function usePreviewSelection(path: string, revision?: string | null) {
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState<{ path: string; text: string } | null>(
    null,
  );
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
      setValue({ path, text });
    };
    document.addEventListener("selectionchange", capture);
    return () => document.removeEventListener("selectionchange", capture);
  }, [path, revision]);
  return {
    ref,
    text: value?.path === path ? value.text : "",
    setText: (text: string) => setValue(text.trim() ? { path, text } : null),
    clear: () => setValue(null),
  };
}
