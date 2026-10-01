import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Quote } from "lucide-react";
import { dispatchComposerInsert, quoteMarkdown } from "../composerMention";
import "./TimelineQuote.css";

const QUOTABLE = ".bubble.user, .bubble.assistant";

function quotableBubble(node: Node | null, root: HTMLElement): Element | null {
  const element = node instanceof Element ? node : node?.parentElement ?? null;
  if (!element || element.closest(".tool-transcript")) return null;
  const bubble = element.closest(QUOTABLE);
  return bubble && root.contains(bubble) ? bubble : null;
}

/** Text selected inside one user/assistant bubble of `root`, if any. */
export function quotableSelection(root: HTMLElement | null): { text: string; rect: DOMRect } | null {
  const selection = window.getSelection();
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const bubble = quotableBubble(selection.anchorNode, root);
  if (!bubble || bubble !== quotableBubble(selection.focusNode, root)) return null;
  const range = selection.getRangeAt(0);
  const rects = range.getClientRects?.();
  const rect = rects && rects.length > 0 ? rects[0] : range.getBoundingClientRect?.();
  if (!rect) return null;
  return { text, rect };
}

/** Floating "引用" button for text selected in conversation bubbles. */
export function TimelineQuote(props: { scrollRef: RefObject<HTMLElement | null> }) {
  const [state, setState] = useState<{ text: string; top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const root = props.scrollRef.current;
    if (!root) return;
    const update = () => {
      // Let the browser finalize the selection after mouseup / keyup.
      window.setTimeout(() => {
        const current = quotableSelection(props.scrollRef.current);
        if (!current) {
          setState(null);
          return;
        }
        const top = current.rect.top - 36 < 8 ? current.rect.bottom + 6 : current.rect.top - 36;
        const left = Math.max(8, Math.min(current.rect.left, window.innerWidth - 80));
        setState({ text: current.text, top, left });
      }, 0);
    };
    const hide = () => setState(null);
    const pointerDown = (event: PointerEvent) => {
      if (!buttonRef.current?.contains(event.target as Node)) hide();
    };
    const selectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) hide();
    };
    root.addEventListener("mouseup", update);
    root.addEventListener("keyup", update);
    root.addEventListener("scroll", hide, { passive: true });
    window.addEventListener("resize", hide);
    document.addEventListener("pointerdown", pointerDown);
    document.addEventListener("selectionchange", selectionChange);
    return () => {
      root.removeEventListener("mouseup", update);
      root.removeEventListener("keyup", update);
      root.removeEventListener("scroll", hide);
      window.removeEventListener("resize", hide);
      document.removeEventListener("pointerdown", pointerDown);
      document.removeEventListener("selectionchange", selectionChange);
    };
  }, [props.scrollRef]);

  if (!state) return null;
  return createPortal(
    <button
      ref={buttonRef}
      type="button"
      className="timeline-quote-button"
      style={{ top: state.top, left: state.left }}
      title="引用到输入框"
      // Keep the text selection alive until the click is handled.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        dispatchComposerInsert(quoteMarkdown(state.text));
        window.getSelection()?.removeAllRanges();
        setState(null);
      }}
    >
      <Quote size={14} aria-hidden="true" />
      引用
    </button>,
    document.body,
  );
}
