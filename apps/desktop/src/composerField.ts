import type { KeyboardEvent, RefObject } from "react";

/** The composer field, whether it is one textarea or several chip-split ones. */
export type ComposerField = HTMLTextAreaElement | HTMLElement;

export function isComposerTextarea(node: EventTarget | null): node is HTMLTextAreaElement {
  return node instanceof HTMLTextAreaElement;
}

/** Visible textareas of one composer, in document order. */
export function fieldTextareas(root: HTMLElement | null): HTMLTextAreaElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLTextAreaElement>("textarea.composer-segment")];
}

/** The segment that owns the caret, or the last one when focus is elsewhere. */
export function activeTextarea(root: HTMLElement | null): HTMLTextAreaElement | null {
  const areas = fieldTextareas(root);
  if (areas.length === 0) return null;
  const active = document.activeElement;
  return areas.find((area) => area === active) ?? areas[areas.length - 1];
}

export function focusTextarea(area: HTMLTextAreaElement | null, cursor?: number) {
  if (!area) return;
  area.focus();
  const position = cursor ?? area.value.length;
  area.setSelectionRange(position, position);
}

/**
 * Plain text of the whole field. A chip counts as its placeholder, so slash
 * commands, mentions and drafts keep one string.
 */
export function readComposerValue(root: HTMLElement | null): string {
  if (!root) return "";
  let value = "";
  for (const node of root.childNodes) {
    if (node instanceof HTMLTextAreaElement) value += node.value;
    else if (node instanceof HTMLElement && node.dataset.placeholder)
      value += node.dataset.placeholder;
  }
  return value;
}

/** Caret as an offset into {@link readComposerValue}, or the end when blurred. */
export function readComposerCaret(root: HTMLElement | null): number {
  if (!root) return 0;
  let offset = 0;
  for (const node of root.childNodes) {
    if (node instanceof HTMLTextAreaElement) {
      if (document.activeElement === node) return offset + node.selectionStart;
      offset += node.value.length;
    } else if (node instanceof HTMLElement && node.dataset.placeholder) {
      offset += node.dataset.placeholder.length;
    }
  }
  return offset;
}

function segmentAt(root: HTMLElement, cursor: number): { area: HTMLTextAreaElement; offset: number } | null {
  let offset = 0;
  let last: HTMLTextAreaElement | null = null;
  for (const node of root.childNodes) {
    if (!(node instanceof HTMLTextAreaElement)) {
      if (node instanceof HTMLElement && node.dataset.placeholder)
        offset += node.dataset.placeholder.length;
      continue;
    }
    const end = offset + node.value.length;
    if (cursor <= end) return { area: node, offset: cursor - offset };
    offset = end;
    last = node;
  }
  return last ? { area: last, offset: last.value.length } : null;
}

/** Puts the caret at one offset of the combined draft after React commits it. */
export function placeComposerCaret(root: HTMLElement | null, cursor: number) {
  if (!root) return;
  const target = segmentAt(root, cursor);
  if (target) focusTextarea(target.area, target.offset);
}

export interface ComposerKeyOptions {
  enterSends: boolean;
  /** Returns this session's last user message for ↑ in an empty input. */
  recallLast?: () => string | undefined;
}

/**
 * Enter sends, Shift+Enter breaks the line, and ↑ recalls the last message.
 * Chip-adjacent keys (Backspace, Delete, arrows) move across the field.
 */
export function handleComposerFieldKey(
  event: KeyboardEvent<HTMLTextAreaElement>,
  fieldRef: RefObject<HTMLElement | null>,
  onDraftChange: (value: string) => void,
  onSend: () => void,
  options: ComposerKeyOptions,
): void {
  const textarea = event.currentTarget;
  if (
    event.key === "ArrowUp" &&
    options.recallLast &&
    !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey &&
    !event.nativeEvent.isComposing &&
    event.nativeEvent.keyCode !== 229 &&
    !textarea.readOnly &&
    !textarea.disabled &&
    readComposerValue(fieldRef.current) === ""
  ) {
    const recalled = options.recallLast();
    if (!recalled) return;
    event.preventDefault();
    onDraftChange(recalled);
    const field = fieldRef.current;
    requestAnimationFrame(() => placeComposerCaret(field, recalled.length));
    return;
  }

  if (moveAcrossChip(event, fieldRef.current)) return;

  if (
    event.key !== "Enter" ||
    event.nativeEvent.isComposing ||
    event.nativeEvent.keyCode === 229 ||
    textarea.readOnly ||
    textarea.disabled
  ) return;

  event.preventDefault();
  if (!event.shiftKey && (options.enterSends || event.ctrlKey || event.metaKey)) {
    onSend();
    return;
  }

  const field = fieldRef.current;
  const value = readComposerValue(field);
  const start = caretInField(field, textarea, textarea.selectionStart);
  const end = caretInField(field, textarea, textarea.selectionEnd);
  const next = `${value.slice(0, start)}\n${value.slice(end)}`;
  onDraftChange(next);
  requestAnimationFrame(() => placeComposerCaret(field, start + 1));
}

function caretInField(root: HTMLElement | null, area: HTMLTextAreaElement, local: number): number {
  if (!root) return local;
  let offset = 0;
  for (const node of root.childNodes) {
    if (node === area) return offset + local;
    if (node instanceof HTMLTextAreaElement) offset += node.value.length;
    else if (node instanceof HTMLElement && node.dataset.placeholder)
      offset += node.dataset.placeholder.length;
  }
  return local;
}

/** Steps or deletes across a chip when the caret sits against it. */
function moveAcrossChip(event: KeyboardEvent<HTMLTextAreaElement>, root: HTMLElement | null): boolean {
  if (!root || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
  const area = event.currentTarget;
  const collapsed = area.selectionStart === area.selectionEnd;
  if (!collapsed) return false;
  const atStart = area.selectionStart === 0;
  const atEnd = area.selectionStart === area.value.length;
  const key = event.key;

  if ((key === "Backspace" || key === "ArrowLeft") && atStart) {
    const chip = previousChip(area);
    if (!chip) return false;
    event.preventDefault();
    if (key === "Backspace") removeChip(root, chip);
    else focusChipEdge(chip, "before");
    return true;
  }
  if ((key === "Delete" || key === "ArrowRight") && atEnd) {
    const chip = nextChip(area);
    if (!chip) return false;
    event.preventDefault();
    if (key === "Delete") removeChip(root, chip);
    else focusChipEdge(chip, "after");
    return true;
  }
  return false;
}

function previousChip(area: HTMLTextAreaElement): HTMLElement | null {
  const chip = area.previousElementSibling;
  return chip instanceof HTMLElement && chip.dataset.placeholder ? chip : null;
}

function nextChip(area: HTMLTextAreaElement): HTMLElement | null {
  const chip = area.nextElementSibling;
  return chip instanceof HTMLElement && chip.dataset.placeholder ? chip : null;
}

function removeChip(root: HTMLElement, chip: HTMLElement) {
  const before = chip.previousElementSibling;
  const cursor = before instanceof HTMLTextAreaElement ? before.value.length : 0;
  chip.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  requestAnimationFrame(() => {
    const area = before instanceof HTMLTextAreaElement && before.isConnected
      ? before
      : fieldTextareas(root)[0];
    focusTextarea(area ?? null, area === before ? cursor : 0);
  });
}

function focusChipEdge(chip: HTMLElement, edge: "before" | "after") {
  const sibling = edge === "before" ? chip.previousElementSibling : chip.nextElementSibling;
  if (!(sibling instanceof HTMLTextAreaElement)) return;
  focusTextarea(sibling, edge === "before" ? sibling.value.length : 0);
}
