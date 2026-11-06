import { Brain, ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import "./DeepThinking.css";

/** Provider-exposed thinking stays separate from the answer and its actions. */
export function DeepThinking({ text, streaming = false }: {
  text?: string;
  streaming?: boolean;
}) {
  const [expanded, setExpanded] = useState(streaming);
  const contentId = useId();
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  useEffect(() => {
    const content = contentRef.current;
    if (expanded && streaming && following.current && content) {
      content.scrollTop = content.scrollHeight;
    }
  }, [text, expanded, streaming]);

  if (!text) return null;
  return <section className={`deep-thinking${streaming ? " is-thinking" : ""}`}>
    <button type="button" className="deep-thinking-toggle"
      aria-expanded={expanded} aria-controls={contentId}
      onClick={() => setExpanded((value) => !value)}>
      <Brain size={16} aria-hidden="true" />
      <span>深度思考</span>
      {streaming && <span className="deep-thinking-status">思考中…</span>}
      <ChevronDown size={14} className={expanded ? "is-expanded" : ""} aria-hidden="true" />
    </button>
    <div id={contentId} role="region" aria-label="思考内容" hidden={!expanded}
      className="deep-thinking-content" ref={contentRef}
      onScroll={(event) => {
        const node = event.currentTarget;
        following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 32;
      }}>{text}</div>
  </section>;
}
