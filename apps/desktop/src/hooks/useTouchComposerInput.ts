import { useSyncExternalStore } from "react";
import { COMPOSER_KEYBOARD_HINT } from "../composerInput";

const QUERY = "(pointer: coarse)";
function subscribe(onChange: () => void) {
  const media = window.matchMedia?.(QUERY);
  media?.addEventListener("change", onChange);
  return () => media?.removeEventListener("change", onChange);
}
function isTouchInput() {
  return window.matchMedia?.(QUERY).matches ?? false;
}

/** Soft keyboards need an ordinary Return key; hardware shortcuts still work. */
export function useTouchComposerInput() {
  const touchInput = useSyncExternalStore(subscribe, isTouchInput, () => false);
  return {
    enterSends: !touchInput,
    keyboardHint: touchInput ? "回车换行，点击发送按钮" : COMPOSER_KEYBOARD_HINT,
  };
}
