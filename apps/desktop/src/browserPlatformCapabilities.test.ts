import { afterEach, describe, expect, it, vi } from "vitest";
import { browserCapabilities, evaluateBrowser, screenshotBrowser } from "./browserWorkbench";
import { isTauriRuntime } from "./runtime";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./runtime", () => ({ isTauriRuntime: vi.fn(() => false) }));
afterEach(() => vi.resetAllMocks());

describe("browser automation platform boundary", () => {
  it("does not advertise or invoke local automation in web and Capacitor clients", async () => {
    expect(await browserCapabilities()).toEqual({
      navigationControl: false, domSnapshot: false, elementLocators: false, screenshot: false,
      tabs: false, pointerInput: false, independentPointer: false, keyboardInput: false, selectInput: false,
    });
    await expect(evaluateBrowser("view", "script")).rejects.toThrow("DOM 自动化");
    await expect(screenshotBrowser("view")).rejects.toThrow("截图");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses the native driver's reported capability contract", async () => {
    vi.mocked(isTauriRuntime).mockReturnValue(true);
    const flags = { domSnapshot: true, elementLocators: true, independentPointer: true, screenshot: false };
    invoke.mockResolvedValue(flags);
    expect(await browserCapabilities()).toBe(flags);
    expect(invoke).toHaveBeenCalledWith("browser_capabilities", {});
  });
});
