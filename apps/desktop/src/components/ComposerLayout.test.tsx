// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComposerCard } from "./Composer";

let notifyResize!: () => void;
let textareaWidth = 500;

beforeEach(() => {
  textareaWidth = 500;
  notifyResize = () => {};
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        notifyResize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ width: textareaWidth }) as DOMRect,
  );
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get: () => 48,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("recomputes composer height when its width changes during a sidebar drag", () => {
  render(
    <ComposerCard
      busy={false}
      placeholder="消息"
      draftKey="layout"
      onSend={vi.fn()}
    />,
  );
  const textarea = screen.getByRole<HTMLTextAreaElement>("textbox");
  expect(textarea.style.height).toBe("48px");

  Object.defineProperty(textarea, "scrollHeight", {
    configurable: true,
    value: 176,
  });
  textareaWidth = 340;
  notifyResize();

  expect(textarea.style.height).toBe("176px");
});
