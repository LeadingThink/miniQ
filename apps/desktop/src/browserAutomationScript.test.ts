// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildBrowserAutomationScript,
  parseBrowserScriptResult,
} from "./browserAutomationScript";

function execute(operation: string, arguments_: Record<string, unknown>) {
  const script = buildBrowserAutomationScript(operation, arguments_, "tab-1");
  return parseBrowserScriptResult(JSON.stringify(eval(script)));
}

describe("embedded browser automation script", () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="save">Save</button>';
    Object.defineProperty(document.body, "innerText", {
      configurable: true,
      value: "Save",
    });
    const button = document.querySelector("button")!;
    Object.defineProperty(button, "innerText", {
      configurable: true,
      value: "Save",
    });
    button.getBoundingClientRect = () =>
      ({ x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 }) as DOMRect;
  });

  afterEach(() => vi.restoreAllMocks());

  it("creates observation-bound targets", () => {
    const result = execute("snapshot", {
      nextObservationId: "observation-1",
      offset: 0,
      limit: 100,
    });
    expect(result.observationId).toBe("observation-1");
    expect(result.tabId).toBe("tab-1");
    expect(result.items).toEqual([
      expect.objectContaining({ target: "rpa-observation-1-0", text: "Save" }),
    ]);
  });

  it("keeps a stable identity for the current document", () => {
    const first = execute("snapshot", { nextObservationId: "observation-1" });
    const second = execute("snapshot", { nextObservationId: "observation-2" });

    expect(first.documentId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second.documentId).toBe(first.documentId);
    expect(first.documentId).not.toBe(String(performance.timeOrigin));
  });

  it("clicks only a target from the expected observation", () => {
    const click = vi.fn();
    document.querySelector("button")!.addEventListener("click", click);
    const observed = execute("snapshot", { nextObservationId: "observation-1" });
    execute("click", {
      nextObservationId: "observation-2",
      observationId: "observation-1",
      target: "rpa-observation-1-0",
      expectedObservation: observed,
    });
    expect(click).toHaveBeenCalledOnce();
  });

  it("rejects stale page state before interaction", () => {
    const observed = execute("snapshot", { nextObservationId: "observation-1" });
    expect(() =>
      execute("click", {
        nextObservationId: "observation-2",
        observationId: "observation-1",
        target: "rpa-observation-1-0",
        expectedObservation: { ...observed, documentId: "replaced-document" },
      }),
    ).toThrow("stale observation");
  });
});
