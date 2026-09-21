// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useGlobalShortcuts, type ShortcutHandlers } from "./useGlobalShortcuts";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockPlatform(platform: string) {
  return vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
}

function Harness({ handlers }: { handlers: ShortcutHandlers }) {
  useGlobalShortcuts(handlers);
  return null;
}

it("focuses the current session search for Windows Ctrl+F", () => {
  const onSessionSearch = vi.fn();
  mockPlatform("Win32");
  render(<Harness handlers={{
    onPalette: vi.fn(),
    onNewChat: vi.fn(),
    onSettings: vi.fn(),
    onSessionSearch,
  }} />);

  const event = new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true, ctrlKey: true });
  window.dispatchEvent(event);

  expect(onSessionSearch).toHaveBeenCalledOnce();
  expect(event.defaultPrevented).toBe(true);
});

it.each([
  { label: "macOS Command+F", metaKey: true },
  { label: "macOS Option+F", altKey: true },
])("focuses the current session search for $label", ({ metaKey, altKey }) => {
  const onSessionSearch = vi.fn();
  mockPlatform("MacIntel");
  render(<Harness handlers={{
    onPalette: vi.fn(),
    onNewChat: vi.fn(),
    onSettings: vi.fn(),
    onSessionSearch,
  }} />);

  const event = new KeyboardEvent("keydown", {
    key: "f",
    bubbles: true,
    cancelable: true,
    metaKey,
    altKey,
  });
  window.dispatchEvent(event);

  expect(onSessionSearch).toHaveBeenCalledOnce();
  expect(event.defaultPrevented).toBe(true);
});

it("recognizes macOS Option+F even when the browser reports the composed key", () => {
  const onSessionSearch = vi.fn();
  mockPlatform("MacIntel");
  render(<Harness handlers={{
    onPalette: vi.fn(),
    onNewChat: vi.fn(),
    onSettings: vi.fn(),
    onSessionSearch,
  }} />);
  const event = new KeyboardEvent("keydown", {
    key: "ƒ",
    code: "KeyF",
    bubbles: true,
    cancelable: true,
    altKey: true,
  });
  window.dispatchEvent(event);
  expect(onSessionSearch).toHaveBeenCalledOnce();
  expect(event.defaultPrevented).toBe(true);
});

it("leaves Windows Alt+F available to the system", () => {
  const onSessionSearch = vi.fn();
  mockPlatform("Win32");
  render(<Harness handlers={{
    onPalette: vi.fn(),
    onNewChat: vi.fn(),
    onSettings: vi.fn(),
    onSessionSearch,
  }} />);
  const event = new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true, altKey: true });
  window.dispatchEvent(event);
  expect(onSessionSearch).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
});

it("does not replace the browser shortcut when no session search handler is available", () => {
  mockPlatform("Win32");
  render(<Harness handlers={{
    onPalette: vi.fn(),
    onNewChat: vi.fn(),
    onSettings: vi.fn(),
  }} />);

  const event = new KeyboardEvent("keydown", {
    key: "f",
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
  });
  window.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(false);
});

it("leaves the browser shortcut available when no active session search exists", () => {
  mockPlatform("Win32");
  render(<Harness handlers={{
    onPalette: vi.fn(),
    onNewChat: vi.fn(),
    onSettings: vi.fn(),
    onSessionSearch: () => false,
  }} />);
  const event = new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true, ctrlKey: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false);
});

it("focuses the active session input and selects its query", () => {
  const search = document.createElement("input");
  search.dataset.sessionSearch = "true";
  search.value = "当前查询";
  const activeMain = document.createElement("main");
  activeMain.className = "main";
  activeMain.dataset.appActive = "true";
  activeMain.append(search);
  document.body.append(activeMain);

  render(<Harness handlers={{
    onPalette: vi.fn(),
    onNewChat: vi.fn(),
    onSettings: vi.fn(),
    onSessionSearch: () => {
      const input = document.querySelector<HTMLInputElement>(
        '.main[data-app-active="true"] input[data-session-search="true"]',
      );
      input?.focus();
      input?.select();
    },
  }} />);
  fireEvent.keyDown(window, { key: "f", ctrlKey: true });

  expect(document.activeElement).toBe(search);
  expect(search.selectionStart).toBe(0);
  expect(search.selectionEnd).toBe(search.value.length);
});
