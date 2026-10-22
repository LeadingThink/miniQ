import { useEffect, useRef, type RefObject } from "react";
import { clipboardFiles } from "../clipboardFiles";
import { pickComposerTarget } from "../composerTarget";

/** Text, files, or both carried by one clipboard paste. */
export interface ComposerPaste {
  text: string;
  files: File[];
}

type Target = {
  input: RefObject<HTMLElement | null>;
  receive: RefObject<(paste: ComposerPaste) => void>;
};

const targets: Target[] = [];

function editable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

/**
 * Route a paste that no editor claimed into the active composer. Selecting
 * text in the transcript, or clicking a message action such as "复制", leaves
 * focus outside the input; the WebView then drops the paste entirely, which
 * looks like a broken clipboard.
 */
function receivePaste(event: ClipboardEvent) {
  const data = event.clipboardData;
  if (!data || event.defaultPrevented || editable(event.target)) return;
  // A modal owns its paste; never write it into a composer behind it.
  if (document.querySelector('[aria-modal="true"]')) return;
  const target = pickComposerTarget(targets);
  if (!target) return;
  const files = clipboardFiles(data);
  const text = files.length > 0 ? "" : data.getData("text/plain");
  if (files.length === 0 && !text.trim()) return;
  event.preventDefault();
  target.receive.current({ text, files });
}

let subscribed = false;

function subscribe() {
  if (subscribed) return;
  document.addEventListener("paste", receivePaste);
  subscribed = true;
}

function unsubscribe() {
  if (!subscribed || targets.length > 0) return;
  document.removeEventListener("paste", receivePaste);
  subscribed = false;
}

/** Receives clipboard pastes made while the composer does not hold focus. */
export function usePastedInput(
  input: RefObject<HTMLElement | null>,
  onPaste: (paste: ComposerPaste) => void,
) {
  const receive = useRef(onPaste);
  receive.current = onPaste;
  useEffect(() => {
    const target: Target = { input, receive };
    targets.push(target);
    subscribe();
    return () => {
      targets.splice(targets.indexOf(target), 1);
      unsubscribe();
    };
  }, [input]);
}
