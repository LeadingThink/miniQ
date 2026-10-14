// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAnchoredPosition } from "./useAnchoredPosition";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  const viewport = Object.assign(new EventTarget(), {
    width: 390,
    height: 844,
    offsetLeft: 0,
    offsetTop: 0,
  });
  vi.stubGlobal("visualViewport", viewport);
  const anchor = document.createElement("button");
  const floating = document.createElement("div");
  vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue({
    left: 60,
    top: 80,
    bottom: 120,
  } as DOMRect);
  // Transforms can shrink a measured rect during the opening animation.
  vi.spyOn(floating, "getBoundingClientRect").mockReturnValue({
    width: 180,
    height: 150,
  } as DOMRect);
  Object.defineProperties(floating, {
    offsetWidth: { value: 360 },
    offsetHeight: { value: 300 },
    scrollHeight: { value: 300 },
  });
  const anchorRef = { current: anchor },
    floatingRef = { current: floating };
  return {
    viewport,
    ...renderHook(() => useAnchoredPosition(anchorRef, floatingRef, true)),
  };
}

it("keeps the full dropdown inside a narrow viewport during its opening animation", () => {
  const { result } = setup();
  expect(result.current?.left).toBe(22);
  expect(result.current!.left + 360).toBeLessThanOrEqual(390 - 8);
  expect(result.current?.top).toBe(128);
});

it("repositions and limits the menu when the phone keyboard changes the visible viewport", () => {
  const { viewport, result } = setup();
  act(() => {
    viewport.height = 300;
    viewport.dispatchEvent(new Event("resize"));
  });
  expect(result.current?.maxHeight).toBe(164);
  expect(result.current!.top + result.current!.maxHeight).toBeLessThanOrEqual(
    292,
  );
  act(() => {
    viewport.offsetTop = 40;
    viewport.offsetLeft = 10;
    viewport.dispatchEvent(new Event("scroll"));
  });
  expect(result.current?.left).toBe(32);
  expect(result.current?.top).toBe(128);
  expect(result.current?.maxHeight).toBe(204);
});
