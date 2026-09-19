// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserCapabilities } from "./types";
import {
  registerEmbeddedBrowser,
  executeEmbeddedBrowserRequest,
} from "./embeddedBrowserDriver";

const capabilities: BrowserCapabilities = {
  navigationControl: false,
  domSnapshot: true,
  screenshot: false,
  tabs: false,
  pointerInput: true,
  keyboardInput: true,
  selectInput: true,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("embedded BrowserDriver bridge", () => {
  it("uses the selected real page and preserves the adapter's result", async () => {
    const execute = vi.fn(async () => ({ tabId: "manual-page", loggedIn: true }));
    const unregister = registerEmbeddedBrowser("manual-page", {
      execute, capabilities: async () => capabilities,
    });
    const response = await executeEmbeddedBrowserRequest("manual-page", "snapshot", { nextObservationId: "observation-manual-request" });
    expect(execute).toHaveBeenCalledWith("snapshot", { nextObservationId: "observation-manual-request" });
    expect(response).toEqual({ capabilities, result: { tabId: "manual-page", loggedIn: true } });
    unregister();
  });

  it("returns native capabilities alongside the latest page observation", async () => {
    const execute = vi.fn(async () => ({ observationId: "observation-request-1" }));
    const unregister = registerEmbeddedBrowser("task-1", {
      execute,
      capabilities: async () => capabilities,
    });
    const response = await executeEmbeddedBrowserRequest("task-1", "snapshot", { nextObservationId: "observation-request-1" });
    expect(response).toEqual({ capabilities, result: { observationId: "observation-request-1" } });

    expect(execute).toHaveBeenCalledWith("snapshot", {
      nextObservationId: "observation-request-1",
    });
    unregister();
  });

  it("waits for the matching hidden browser host to register", async () => {
    const resolved = vi.fn();
    const resolving = executeEmbeddedBrowserRequest("task-2", "snapshot", {});
    void resolving.then(resolved);
    await Promise.resolve();
    expect(resolved).not.toHaveBeenCalled();

    const unregister = registerEmbeddedBrowser("task-2", {
      execute: async () => ({ ready: true }),
      capabilities: async () => capabilities,
    });
    await expect(resolving).resolves.toEqual({ capabilities, result: { ready: true } });
    unregister();
  });

  it("rejects without fabricating a result when adapter execution fails", async () => {
    const unregister = registerEmbeddedBrowser("task-3", {
      execute: async () => { throw new Error("script rejected"); },
      capabilities: async () => capabilities,
    });
    await expect(executeEmbeddedBrowserRequest("task-3", "snapshot", {})).rejects.toThrow("script rejected");
    unregister();
  });

  it("cleans a timed-out waiter before a later adapter registers", async () => {
    vi.useFakeTimers();
    const timedOut = executeEmbeddedBrowserRequest("task-4", "snapshot", {});
    const assertion = expect(timedOut).rejects.toThrow("内嵌浏览器面板未能在 5 秒内就绪");
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    const execute = vi.fn(async () => ({ ready: true }));
    const unregister = registerEmbeddedBrowser("task-4", {
      execute,
      capabilities: async () => capabilities,
    });
    expect(execute).not.toHaveBeenCalled();
    await executeEmbeddedBrowserRequest("task-4", "snapshot", {});
    expect(execute).toHaveBeenCalledTimes(1);
    unregister();
  });
});
