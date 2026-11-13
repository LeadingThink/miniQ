// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRef } from "react";
import { SessionModelSurface } from "./SessionModelSurface";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function bounds(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) };
}

it("keeps the desktop model picker outside the native browser surface", () => {
  vi.stubGlobal("innerWidth", 1200);
  const browser = document.createElement("div");
  browser.className = "browser-panel";
  const surface = document.createElement("div");
  surface.className = "browser-surface";
  vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(bounds(630, 170, 570, 730));
  browser.append(surface);
  document.body.append(browser);

  const trigger = document.createElement("button");
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(bounds(383, 720, 120, 24));
  const triggerRef = createRef<HTMLButtonElement>();
  triggerRef.current = trigger;

  render(<SessionModelSurface mobile={false} trigger={triggerRef} onClose={() => undefined}>
    <div className="session-model-popover">Models</div>
  </SessionModelSurface>);

  const portal = document.querySelector<HTMLElement>(".session-model-surface-portal");
  expect(portal?.style.left).toBe("74px");
  expect(portal?.style.width).toBe("540px");
  expect(Number.parseFloat(portal!.style.left) + Number.parseFloat(portal!.style.width)).toBeLessThan(630);
});