import { describe, expect, it, vi } from "vitest";
import {
  COMMAND_EVENT,
  COMMAND_IDS,
  SHORTCUTS,
  dispatchCommand,
  groupShortcuts,
  isCommandId,
  matchShortcut,
  shortcutLabel,
} from "./shortcuts";

const key = (init: Partial<KeyboardEvent> & { code?: string; key?: string }) => ({
  key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null, ...init,
}) as unknown as KeyboardEvent;

describe("shortcut registry", () => {
  it("has unique ids and a definition for every command id", () => {
    const ids = SHORTCUTS.map((shortcut) => shortcut.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of COMMAND_IDS) expect(ids).toContain(id);
  });

  it("formats labels per platform", () => {
    expect(shortcutLabel("archiveSession", true)).toBe("⌘⇧A");
    expect(shortcutLabel("archiveSession", false)).toBe("Ctrl+Shift+A");
    expect(shortcutLabel("copyMarkdown", true)).toBe("");
  });

  it("groups by section in display order", () => {
    expect(groupShortcuts().map((group) => group.section)).toEqual(["通用", "导航", "会话", "输入框", "面板"]);
  });

  it("dispatches commands on the bus", () => {
    const listener = vi.fn();
    const target = new EventTarget();
    target.addEventListener(COMMAND_EVENT, listener);
    dispatchCommand("nextSession", target);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: "nextSession" });
    expect(isCommandId("nextSession")).toBe(true);
    expect(isCommandId("nope")).toBe(false);
  });
});

describe("matchShortcut", () => {
  it("matches mac navigation combos by physical key", () => {
    expect(matchShortcut(key({ metaKey: true, shiftKey: true, code: "BracketLeft", key: "{" }), true)).toEqual({ id: "prevSession" });
    expect(matchShortcut(key({ metaKey: true, code: "BracketRight" }), true)).toEqual({ id: "forward" });
    expect(matchShortcut(key({ metaKey: true, code: "Digit3", key: "3" }), true)).toEqual({ id: "openSessionN", index: 2 });
    expect(matchShortcut(key({ metaKey: true, altKey: true, code: "KeyA", key: "å" }), true)).toEqual({ id: "nextAttention" });
    expect(matchShortcut(key({ metaKey: true, altKey: true, code: "KeyP" }), true)).toEqual({ id: "togglePin" });
    expect(matchShortcut(key({ metaKey: true, shiftKey: true, code: "KeyU" }), true)).toEqual({ id: "markUnread" });
    expect(matchShortcut(key({ metaKey: true, key: "/", code: "Slash" }), true)).toEqual({ id: "showShortcuts" });
  });

  it("handles Ctrl+Tab and Shift+Esc on every platform", () => {
    expect(matchShortcut(key({ ctrlKey: true, key: "Tab" }), true)).toEqual({ id: "nextRecentSession" });
    expect(matchShortcut(key({ ctrlKey: true, shiftKey: true, key: "Tab" }), false)).toEqual({ id: "prevRecentSession" });
    expect(matchShortcut(key({ shiftKey: true, key: "Escape" }), false)).toEqual({ id: "markAllRead" });
  });

  it("uses Ctrl off mac and ignores unrelated keys", () => {
    expect(matchShortcut(key({ ctrlKey: true, shiftKey: true, code: "KeyA" }), false)).toEqual({ id: "archiveSession" });
    expect(matchShortcut(key({ metaKey: true, shiftKey: true, code: "KeyA" }), false)).toBeNull();
    expect(matchShortcut(key({ metaKey: true, code: "KeyA" }), true)).toBeNull();
    expect(matchShortcut(key({ key: "a", code: "KeyA" }), true)).toBeNull();
  });

  it("skips composition", () => {
    expect(matchShortcut({ ...key({ metaKey: true, code: "Slash" }), isComposing: true }, true)).toBeNull();
  });
});
