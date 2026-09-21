import { useEffect } from "react";
import {
  containsUnsupportedInput,
  navigateTextSelection,
} from "../textInputNavigation";

export interface ShortcutHandlers {
  /** ⌘/Ctrl+K — open the command palette. */
  onPalette: () => void;
  /** ⌘/Ctrl+N — start a new chat. */
  onNewChat: () => void;
  /** ⌘/Ctrl+, — open settings. */
  onSettings: () => void;
  /** ⌘/Ctrl+. — cancel the running turn (if any). */
  onStop?: () => void;
  /** ⌘/Ctrl+B — toggle the sidebar. */
  onToggleSidebar?: () => void;
  /** ⌘/Ctrl+F (or Option+F on macOS) — focus the current session search.
   * Return false when no active conversation search is available. */
  onSessionSearch?: () => boolean | void;
  /** Escape — close topmost overlay (handled by overlays themselves). */
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

function textControl(
  target: EventTarget | null,
): HTMLInputElement | HTMLTextAreaElement | null {
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement && target.selectionStart !== null) {
    return target;
  }
  return null;
}

function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(`${navigator.platform} ${navigator.userAgent}`);
}

function handleTextNavigation(event: KeyboardEvent): boolean {
  const control = textControl(event.target);
  if (!control) return false;

  if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    const selection = navigateTextSelection(
      control.value,
      {
        start: control.selectionStart ?? 0,
        end: control.selectionEnd ?? 0,
        direction: control.selectionDirection ?? "none",
      },
      event.key,
      event.shiftKey,
      control instanceof HTMLInputElement || event.metaKey || event.ctrlKey,
    );
    control.setSelectionRange(
      selection.start,
      selection.end,
      selection.direction,
    );
    return true;
  }

  if (event.key === "PageUp" || event.key === "PageDown") {
    event.preventDefault();
    if (control instanceof HTMLTextAreaElement) {
      const direction = event.key === "PageUp" ? -1 : 1;
      control.scrollBy({
        top: direction * Math.max(24, control.clientHeight - 24),
      });
    }
    return true;
  }

  return false;
}

/**
 * App-wide keyboard shortcuts, mirroring the ChatGPT desktop app defaults
 * (⌘K palette, ⌘N new chat, ⌘, settings, ⌘. stop, ⌘B sidebar).
 */
export function useGlobalShortcuts(handlers: ShortcutHandlers, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (handleTextNavigation(e)) return;

      const mod = e.metaKey || e.ctrlKey;
      // Keep the browser's find shortcut scoped to the current conversation.
      // macOS reports Option+F as `altKey` without a meta modifier, while
      // Windows/Linux use Ctrl+F. Cmd+F remains supported on macOS too.
      const findShortcut =
        (e.key === "f" || e.key === "F" || e.code === "KeyF") &&
        (isApplePlatform()
          ? (e.altKey && !e.metaKey && !e.ctrlKey) ||
            (e.metaKey && !e.altKey && !e.ctrlKey)
          : e.ctrlKey && !e.altKey && !e.metaKey);
      if (findShortcut) {
        if (handlers.onSessionSearch) {
          if (handlers.onSessionSearch() !== false) e.preventDefault();
        }
        return;
      }
      if (!mod || e.altKey) return;

      switch (e.key) {
        case "k":
        case "K":
          e.preventDefault();
          handlers.onPalette();
          return;
        case "n":
        case "N":
          e.preventDefault();
          handlers.onNewChat();
          return;
        case ",":
          e.preventDefault();
          handlers.onSettings();
          return;
        case ".":
          if (handlers.onStop) {
            e.preventDefault();
            handlers.onStop();
          }
          return;
        case "b":
        case "B":
          // Don't hijack ⌘B while typing (bold in future rich inputs).
          if (isEditableTarget(e.target)) return;
          if (handlers.onToggleSidebar) {
            e.preventDefault();
            handlers.onToggleSidebar();
          }
          return;
      }
    };
    const onBeforeInput = (event: InputEvent) => {
      if (
        event.data &&
        isEditableTarget(event.target) &&
        containsUnsupportedInput(event.data)
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("beforeinput", onBeforeInput, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("beforeinput", onBeforeInput, true);
    };
  }, [handlers, enabled]);
}
