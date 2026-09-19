// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { initializeMobileRuntime } from "./mobileRuntime";

const native = vi.hoisted(() => vi.fn(() => true));
const status = vi.hoisted(() => ({
  setOverlaysWebView: vi.fn(), setStyle: vi.fn(), setBackgroundColor: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: native } }));
vi.mock("@capacitor/status-bar", () => ({ StatusBar: status, Style: { Light: "LIGHT" } }));

afterEach(() => {
  document.documentElement.classList.remove("native-mobile");
  document.head.innerHTML = "";
  vi.clearAllMocks();
});

it("keeps native pinch zoom and touch navigation available after initialization", async () => {
  document.head.innerHTML = '<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">';
  await initializeMobileRuntime();
  expect(document.documentElement.classList.contains("native-mobile")).toBe(true);
  for (const eventType of ["gesturestart", "gesturechange", "gestureend", "touchmove"]) {
    const event = new Event(eventType, { cancelable: true });
    Object.defineProperty(event, "touches", { value: [{}, {}] });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(document.querySelector("meta")?.content).not.toMatch(/maximum-scale|user-scalable/);
  expect(status.setOverlaysWebView).toHaveBeenCalledWith({ overlay: false });
});

it("does not apply native status bar changes to the mobile website", async () => {
  native.mockReturnValueOnce(false);
  await initializeMobileRuntime();
  expect(status.setOverlaysWebView).not.toHaveBeenCalled();
  expect(document.documentElement.classList.contains("native-mobile")).toBe(false);
});
