import type { RefObject } from "react";

export type ComposerTarget = { input: RefObject<HTMLTextAreaElement | null> };

function usable(input: HTMLTextAreaElement | null): input is HTMLTextAreaElement {
  return !!input && input.isConnected && !input.closest("[hidden], [inert], [aria-hidden='true']");
}

/**
 * Chooses the one composer that receives window-level input (text insertion,
 * native file drops): the focused visible composer, otherwise the most
 * recently mounted visible one. Hidden background composers never receive it.
 */
export function pickComposerTarget<T extends ComposerTarget>(targets: readonly T[]): T | undefined {
  const candidates = targets.filter((target) => usable(target.input.current));
  return candidates.find((target) => target.input.current === document.activeElement)
    ?? candidates[candidates.length - 1];
}
