// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installMacTerminalKeyboard, macTerminalText } from "./terminalKeyboard";

afterEach(() => {
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

function keyEvent(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : "";
  return new KeyboardEvent("keydown", { key, code, cancelable: true, ...init });
}

describe("macTerminalText", () => {
  it("recovers a shifted letter when WKWebView reports the lowercase key", () => {
    expect(macTerminalText(keyEvent("c", { shiftKey: true }))).toBe("C");
    expect(macTerminalText(keyEvent("z", { shiftKey: true }))).toBe("Z");
  });

  it("leaves normal xterm input, shortcuts, and composition untouched", () => {
    expect(macTerminalText(keyEvent("C", { shiftKey: true }))).toBeNull();
    expect(macTerminalText(keyEvent("c"))).toBeNull();
    expect(macTerminalText(keyEvent("c", { shiftKey: true, metaKey: true }))).toBeNull();
    expect(macTerminalText(keyEvent("c", { shiftKey: true, ctrlKey: true }))).toBeNull();
    expect(macTerminalText(keyEvent("1", { shiftKey: true }))).toBeNull();
    expect(macTerminalText(keyEvent("c", { shiftKey: true, isComposing: true }))).toBeNull();
  });
});

describe("terminal platform capability", () => {
  it("detects only the macOS Tauri desktop WebView", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    const terminal = { attachCustomKeyEventHandler: vi.fn(), input: vi.fn() };

    installMacTerminalKeyboard(terminal);
    expect(terminal.attachCustomKeyEventHandler).toHaveBeenCalledOnce();
  });

  it("installs the workaround only for the macOS Tauri WebView capability", () => {
    let handler: ((event: KeyboardEvent) => boolean) | undefined;
    const terminal = {
      attachCustomKeyEventHandler: vi.fn((value: (event: KeyboardEvent) => boolean) => { handler = value; }),
      input: vi.fn(),
    };

    installMacTerminalKeyboard(terminal, false);
    expect(terminal.attachCustomKeyEventHandler).not.toHaveBeenCalled();

    installMacTerminalKeyboard(terminal, true);
    expect(terminal.attachCustomKeyEventHandler).toHaveBeenCalledOnce();
    const shifted = keyEvent("c", { shiftKey: true });
    expect(handler!(shifted)).toBe(false);
    expect(shifted.defaultPrevented).toBe(true);
    expect(terminal.input).toHaveBeenCalledWith("C", true);

    const shortcut = keyEvent("c", { shiftKey: true, metaKey: true });
    expect(handler!(shortcut)).toBe(true);
    expect(shortcut.defaultPrevented).toBe(false);
  });
});
