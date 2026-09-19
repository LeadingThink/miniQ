// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "./rpc";
import type { BrowserCapabilities, BrowserDriverRequest } from "./types";
import {
  registerEmbeddedBrowser,
  resolveBrowserDriverRequest,
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

const request = (id: string, browserSessionId: string): BrowserDriverRequest => ({
  id,
  sessionId: "session-1",
  browserSessionId,
  operation: "snapshot",
  arguments: { nextObservationId: `observation-${id}` },
});

const rpc = () => {
  const call = vi.fn(async () => ({ resolved: true }));
  return { call, client: { call } as unknown as RpcClient };
};

afterEach(() => {
  vi.useRealTimers();
});

describe("embedded BrowserDriver bridge", () => {
  it("routes a request by browser session and returns native capabilities", async () => {
    const execute = vi.fn(async () => ({ observationId: "observation-request-1" }));
    const unregister = registerEmbeddedBrowser("task-1", {
      execute,
      capabilities: async () => capabilities,
    });
    const { call, client } = rpc();

    const result = await resolveBrowserDriverRequest(client, request("request-1", "task-1"));
    expect(result).toEqual({ observationId: "observation-request-1" });

    expect(execute).toHaveBeenCalledWith("snapshot", {
      nextObservationId: "observation-request-1",
    });
    expect(call).toHaveBeenCalledWith("browser.resolve", {
      requestId: "request-1",
      result: {
        capabilities,
        result: { observationId: "observation-request-1" },
      },
    });
    unregister();
  });

  it("waits for the matching hidden browser host to register", async () => {
    const { call, client } = rpc();
    const resolving = resolveBrowserDriverRequest(client, request("request-2", "task-2"));
    await Promise.resolve();
    expect(call).not.toHaveBeenCalled();

    const unregister = registerEmbeddedBrowser("task-2", {
      execute: async () => ({ ready: true }),
      capabilities: async () => capabilities,
    });
    await resolving;

    expect(call).toHaveBeenCalledWith("browser.resolve", expect.objectContaining({
      requestId: "request-2",
      result: expect.objectContaining({ result: { ready: true } }),
    }));
    unregister();
  });

  it("returns only an error when adapter execution fails", async () => {
    const unregister = registerEmbeddedBrowser("task-3", {
      execute: async () => { throw new Error("script rejected"); },
      capabilities: async () => capabilities,
    });
    const { call, client } = rpc();

    expect(await resolveBrowserDriverRequest(client, request("request-3", "task-3"))).toBeUndefined();

    expect(call).toHaveBeenCalledWith("browser.resolve", {
      requestId: "request-3",
      error: "script rejected",
    });
    unregister();
  });

  it("cleans a timed-out waiter before a later adapter registers", async () => {
    vi.useFakeTimers();
    const first = rpc();
    const timedOut = resolveBrowserDriverRequest(
      first.client,
      request("request-4", "task-4"),
    );
    await vi.advanceTimersByTimeAsync(5000);
    await timedOut;
    expect(first.call).toHaveBeenCalledWith("browser.resolve", {
      requestId: "request-4",
      error: "内嵌浏览器面板未能在 5 秒内就绪",
    });

    const execute = vi.fn(async () => ({ ready: true }));
    const unregister = registerEmbeddedBrowser("task-4", {
      execute,
      capabilities: async () => capabilities,
    });
    expect(execute).not.toHaveBeenCalled();
    const second = rpc();
    await resolveBrowserDriverRequest(second.client, request("request-5", "task-4"));
    expect(execute).toHaveBeenCalledTimes(1);
    unregister();
  });
});
