export type TextSelectionDirection = "forward" | "backward" | "none";

export interface TextSelection {
  start: number;
  end: number;
  direction: TextSelectionDirection;
}

export interface SanitizedTextInput extends TextSelection {
  value: string;
  changed: boolean;
}

const UNSUPPORTED_CONTROL_CHARACTERS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uF700-\uF747]/g;

function clampPosition(value: string, position: number): number {
  return Math.max(0, Math.min(position, value.length));
}

function lineStart(value: string, position: number): number {
  const cursor = clampPosition(value, position);
  if (cursor === 0) return 0;
  return value.lastIndexOf("\n", cursor - 1) + 1;
}

function lineEnd(value: string, position: number): number {
  const cursor = clampPosition(value, position);
  const newline = value.indexOf("\n", cursor);
  const end = newline === -1 ? value.length : newline;
  return end > 0 && value[end - 1] === "\r" ? end - 1 : end;
}

function selectionFocus(
  start: number,
  end: number,
  direction: TextSelectionDirection,
): number {
  return direction === "backward" ? start : end;
}

/** Resolve Home/End without relying on WKWebView's broken function-key handling. */
export function navigateTextSelection(
  value: string,
  selection: TextSelection,
  key: "Home" | "End",
  extend: boolean,
  documentBoundary: boolean,
): TextSelection {
  const start = clampPosition(value, selection.start);
  const end = clampPosition(value, selection.end);
  const focus = selectionFocus(start, end, selection.direction);
  const target = documentBoundary
    ? key === "Home"
      ? 0
      : value.length
    : key === "Home"
      ? lineStart(value, focus)
      : lineEnd(value, focus);

  if (!extend) return { start: target, end: target, direction: "none" };

  const anchor = selection.direction === "backward" ? end : start;
  if (target < anchor) {
    return { start: target, end: anchor, direction: "backward" };
  }
  if (target > anchor) {
    return { start: anchor, end: target, direction: "forward" };
  }
  return { start: anchor, end: anchor, direction: "none" };
}

function removeUnsupportedCharacters(value: string): string {
  return value.replace(UNSUPPORTED_CONTROL_CHARACTERS, "");
}

/**
 * Strip control/private-use characters emitted by macOS function keys while
 * preserving ordinary text, tabs, and line endings.
 */
export function sanitizeTextInput(
  value: string,
  selectionStart = value.length,
  selectionEnd = selectionStart,
): SanitizedTextInput {
  const sanitized = removeUnsupportedCharacters(value);
  const startPrefix = value.slice(0, clampPosition(value, selectionStart));
  const endPrefix = value.slice(0, clampPosition(value, selectionEnd));
  return {
    value: sanitized,
    start: removeUnsupportedCharacters(startPrefix).length,
    end: removeUnsupportedCharacters(endPrefix).length,
    direction: "none",
    changed: sanitized !== value,
  };
}

export function containsUnsupportedInput(value: string): boolean {
  return removeUnsupportedCharacters(value) !== value;
}
