import { useEffect, useRef, type RefObject } from "react";
import { COMPOSER_INSERT_EVENT } from "../composerMention";

type Target = {
  input: RefObject<HTMLTextAreaElement | null>;
  insert: RefObject<(text: string) => void>;
};

// Every mounted composer registers here; one window listener chooses which
// one receives `miniq:composer-insert`, so hidden or duplicate composers
// (e.g. fixtures, background views) never receive the same text twice.
const targets: Target[] = [];

function usable(input: HTMLTextAreaElement | null): input is HTMLTextAreaElement {
  return !!input && input.isConnected && !input.closest("[hidden], [inert], [aria-hidden='true']");
}

function receive(event: Event) {
  const text = (event as CustomEvent<{ text?: unknown }>).detail?.text;
  if (typeof text !== "string" || !text) return;
  const candidates = targets.filter((target) => usable(target.input.current));
  const focused = candidates.find((target) => target.input.current === document.activeElement);
  // Otherwise the most recently mounted composer is the one on screen.
  const target = focused ?? candidates[candidates.length - 1];
  target?.insert.current?.(text);
}

/** Subscribes a composer to the cross-component text insertion bus. */
export function useComposerInsert(
  input: RefObject<HTMLTextAreaElement | null>,
  insert: (text: string) => void,
) {
  const insertRef = useRef(insert);
  insertRef.current = insert;
  useEffect(() => {
    const target: Target = { input, insert: insertRef };
    targets.push(target);
    if (targets.length === 1) window.addEventListener(COMPOSER_INSERT_EVENT, receive);
    return () => {
      targets.splice(targets.indexOf(target), 1);
      if (targets.length === 0) window.removeEventListener(COMPOSER_INSERT_EVENT, receive);
    };
  }, [input]);
}
