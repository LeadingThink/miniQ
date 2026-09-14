// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { initializeMobileViewport } from "./mobileViewport";

const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.documentElement.style.removeProperty("--app-height");
  document.documentElement.style.removeProperty("--keyboard-inset");
});

describe("mobile viewport", () => {
  it("anchors the shell to the layout viewport and exposes keyboard inset", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    const visualViewport = new EventTarget() as EventTarget & { height: number };
    visualViewport.height = 512;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visualViewport });

    cleanups.push(initializeMobileViewport());

    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("844px");
    expect(document.documentElement.style.getPropertyValue("--keyboard-inset")).toBe("332px");
  });

  it("removes resize listeners when the shell is disposed", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
    const visualViewport = new EventTarget() as EventTarget & { height: number };
    visualViewport.height = 800;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visualViewport });
    const cleanup = initializeMobileViewport();

    cleanup();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 700 });
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--app-height")).toBe("800px");
  });
});
