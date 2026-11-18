// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PlatformOverlay from "./PlatformOverlay";
import { signalPlatformOverlayAction } from "../platformOverlay";

vi.mock("../platformOverlay", () => ({ signalPlatformOverlayAction: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(signalPlatformOverlayAction).mockResolvedValue(undefined);
  window.__MINIQ_PLATFORM__ = { platform: "zaiwen", requestId: "first", anchor: { left: 100, top: 0, bottom: 40, width: 120, height: 40 } };
});
afterEach(() => {
  cleanup();
  delete window.__MINIQ_PLATFORM__;
});

it.each(["miniq", "zaiwen"] as const)("renders the choices and sends exactly one %s action without a competing close", (target) => {
  render(<PlatformOverlay />);
  const site = screen.getByRole("menuitemradio", { name: "在问" });
  const local = screen.getByRole("menuitemradio", { name: "miniQ" });
  expect(site.getAttribute("aria-checked")).toBe("true");
  expect(local.getAttribute("aria-checked")).toBe("false");
  expect(site.querySelector("svg")).toBeTruthy();
  expect(local.querySelector("svg")).toBeNull();
  expect(screen.getByText("创作、学习和探索")).toBeTruthy();
  expect(screen.getByText("构建、调试和发布")).toBeTruthy();
  fireEvent.click((target === "miniq" ? local : site).querySelector("small")!);
  expect(vi.mocked(signalPlatformOverlayAction).mock.calls).toEqual([[target]]);
});

it("shows a command failure instead of silently leaving a click without a result", async () => {
  vi.mocked(signalPlatformOverlayAction).mockRejectedValueOnce(new Error("native command unavailable"));
  render(<PlatformOverlay />);
  fireEvent.click(screen.getByRole("menuitemradio", { name: "miniQ" }));
  expect((await screen.findByRole("alert")).textContent).toContain("native command unavailable");
});

it("supports keyboard navigation, Escape, outside click and trigger dismissal", () => {
  const { container } = render(<PlatformOverlay />);
  const site = screen.getByRole("menuitemradio", { name: "在问" });
  const local = screen.getByRole("menuitemradio", { name: "miniQ" });
  expect(document.activeElement).toBe(site);
  fireEvent.keyDown(site, { key: "ArrowDown" });
  expect(document.activeElement).toBe(local);
  fireEvent.keyDown(local, { key: "Escape" });
  expect(signalPlatformOverlayAction).toHaveBeenLastCalledWith("close");
  fireEvent.mouseDown(document.body);
  expect(signalPlatformOverlayAction).toHaveBeenCalledTimes(2);
  fireEvent.mouseDown(container.querySelector(".platform-overlay-anchor")!);
  expect(signalPlatformOverlayAction).toHaveBeenCalledTimes(3);
});

it("refreshes selection and focuses the menu on every reopening", () => {
  render(<PlatformOverlay />);
  fireEvent.keyDown(screen.getByRole("menuitemradio", { name: "在问" }), { key: "ArrowDown" });
  act(() => window.__MINIQ_SET_PLATFORM__?.({ ...window.__MINIQ_PLATFORM__!, requestId: "second", platform: "miniq" }));
  expect(screen.getByRole("menuitemradio", { name: "miniQ" }).getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("menuitemradio", { name: "在问" }).getAttribute("aria-checked")).toBe("false");
  expect(document.activeElement).toBe(screen.getByRole("menuitemradio", { name: "在问" }));
});
