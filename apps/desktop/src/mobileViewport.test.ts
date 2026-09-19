// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeMobileViewport } from "./mobileViewport";

const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.documentElement.style.removeProperty("--app-height");
  document.documentElement.style.removeProperty("--app-offset-top");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setupViewport(height = 844) {
  vi.stubGlobal("innerHeight", height);
  const viewport = Object.assign(new EventTarget(), { height, scale: 1, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  cleanups.push(initializeMobileViewport());
  return viewport;
}

describe("mobile viewport", () => {
  it("fits the composer above the keyboard and restores height after dismissal", () => {
    const viewport = setupViewport();
    viewport.height = 512;
    viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("512px");
    viewport.height = 844;
    viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("844px");
  });

  it("does not mistake pinch zoom for a keyboard or feed zoom back into layout", () => {
    const viewport = setupViewport();
    Object.assign(viewport, { height: 422, scale: 2, offsetTop: 180 });
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("844px");
    expect(document.documentElement.style.getPropertyValue("--app-offset-top")).toBe("0px");
    Object.assign(viewport, { height: 512, scale: 1, offsetTop: 10 });
    viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("512px");
    expect(document.documentElement.style.getPropertyValue("--app-offset-top")).toBe("10px");
  });

  it("handles rotation, native keyboard resizing and viewport panning", () => {
    const viewport = setupViewport();
    vi.stubGlobal("innerHeight", 390);
    viewport.height = 390;
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("390px");
    viewport.height = 210;
    viewport.offsetTop = 12;
    viewport.dispatchEvent(new Event("scroll"));
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("210px");
    expect(document.documentElement.style.getPropertyValue("--app-offset-top")).toBe("12px");
  });

  it("uses the layout height when VisualViewport is unavailable", () => {
    vi.stubGlobal("visualViewport", undefined);
    vi.stubGlobal("innerHeight", 640);
    cleanups.push(initializeMobileViewport());
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("640px");
  });

  it("removes both window and visual viewport listeners when disposed", () => {
    const viewport = setupViewport(800);
    cleanups.splice(0).forEach((cleanup) => cleanup());
    vi.stubGlobal("innerHeight", 700);
    viewport.height = 300;
    viewport.offsetTop = 50;
    window.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("800px");
    expect(document.documentElement.style.getPropertyValue("--app-offset-top")).toBe("0px");
  });
});
