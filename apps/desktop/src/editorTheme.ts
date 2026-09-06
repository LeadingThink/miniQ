import type { editor } from "monaco-editor";
import { THEMES, type ThemeId } from "./theme";

export function editorTheme(id: ThemeId): editor.IStandaloneThemeData {
  const { mode, preview } = THEMES.find((theme) => theme.id === id)!;
  return {
    base: mode === "dark" ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": preview.surface,
      "editor.foreground": preview.text,
      "editorLineNumber.foreground": preview.text + "99",
      "editorLineNumber.activeForeground": preview.text,
      "editorCursor.foreground": preview.accent,
      "editor.selectionBackground": preview.accent + "40",
      "editor.inactiveSelectionBackground": preview.accent + "25",
      "editor.lineHighlightBackground": preview.accent + "10",
      "editorGutter.background": preview.surface,
      "editorWidget.background": preview.surface,
      "editorWidget.foreground": preview.text,
      "editorWidget.border": preview.accent,
      "editorSuggestWidget.background": preview.surface,
      "editorSuggestWidget.foreground": preview.text,
      focusBorder: preview.accent,
    },
  };
}
