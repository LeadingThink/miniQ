import { beforeEach, expect, it, vi } from "vitest";
import type { BrowserScriptResult } from "./browserAutomationScript";
import { captureBrowserObservation } from "./browserVisualObservation";
import { screenshotBrowser } from "./browserWorkbench";

vi.mock("./browserWorkbench", () => ({ screenshotBrowser: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(screenshotBrowser).mockResolvedValue("native-png-base64");
});

function observation(overrides: Partial<BrowserScriptResult> = {}): BrowserScriptResult {
  return {
    observationId: "observation-1", documentId: "document-1", tabId: "view-1",
    url: "https://example.test/form", title: "Form", readyState: "complete",
    viewport: { width: 600, height: 500, deviceScaleFactor: 2, scrollX: 0, scrollY: 0 },
    items: [{ target: "rpa-1", role: "button", text: "Submit" }], textLines: ["Form"],
    total: 1, totalTextLines: 1, offset: 0, limit: 100, hasMore: false, ...overrides,
  };
}

it("returns the native PNG with a matching fresh DOM observation", async () => {
  const observe = vi.fn().mockResolvedValue(observation());
  const result = await captureBrowserObservation("view-1", observe);
  expect(result).toEqual({ ...observation(), screenshotBase64: "native-png-base64" });
  expect(screenshotBrowser).toHaveBeenCalledWith("view-1");
  expect(observe).toHaveBeenCalledTimes(2);
});

it.each([
  observation({ documentId: "document-2" }),
  observation({ viewport: { width: 600, height: 500, deviceScaleFactor: 2, scrollX: 0, scrollY: 200 } }),
  observation({ items: [{ target: "rpa-1", role: "button", text: "Pay" }] }),
  observation({ readyState: "loading" }),
])("rejects pixels taken across a page or layout change", async (changed) => {
  const observe = vi.fn().mockResolvedValueOnce(observation()).mockResolvedValueOnce(changed);
  await expect(captureBrowserObservation("view-1", observe)).rejects.toThrow("截图期间网页发生变化");
  expect(screenshotBrowser).toHaveBeenCalledTimes(1);
});

it("reports native capture failures without returning a misleading DOM-only screenshot", async () => {
  vi.mocked(screenshotBrowser).mockRejectedValue(new Error("WebKit capture failed"));
  await expect(captureBrowserObservation("view-1", vi.fn().mockResolvedValue(observation())))
    .rejects.toThrow("WebKit capture failed");
});
