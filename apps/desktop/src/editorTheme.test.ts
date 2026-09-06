import { describe, expect, it } from "vitest";
import { THEMES } from "./theme";
import { editorTheme } from "./editorTheme";

describe("source preview appearance", () => {
  it.each(THEMES)("follows the $id palette and syntax mode", (theme) => {
    const editor = editorTheme(theme.id);
    expect(editor.base).toBe(theme.mode === "dark" ? "vs-dark" : "vs");
    expect(editor.inherit).toBe(true);
    expect(editor.colors["editor.background"]).toBe(theme.preview.surface);
    expect(editor.colors["editor.foreground"]).toBe(theme.preview.text);
    expect(editor.colors["editorCursor.foreground"]).toBe(theme.preview.accent);
  });
});
