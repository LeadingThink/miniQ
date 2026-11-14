import type { Terminal } from "@xterm/xterm";
import { isMacDesktop } from "./windowChrome";

export function macTerminalText(event: KeyboardEvent): string | null {
  if (
    event.type !== "keydown" ||
    event.isComposing ||
    !event.shiftKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    !/^Key[A-Z]$/.test(event.code) ||
    !/^[a-z]$/.test(event.key)
  ) {
    return null;
  }
  return event.key.toLocaleUpperCase();
}

/** Work around WKWebView dropping a lone Shift+letter before xterm emits onData. */
export function installMacTerminalKeyboard(
  terminal: Pick<Terminal, "attachCustomKeyEventHandler" | "input">,
  macDesktop = isMacDesktop(),
): void {
  if (!macDesktop) return;
  terminal.attachCustomKeyEventHandler((event) => {
    const text = macTerminalText(event);
    if (text === null) return true;
    event.preventDefault();
    terminal.input(text, true);
    return false;
  });
}
