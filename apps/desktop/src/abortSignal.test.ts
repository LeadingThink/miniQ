import { describe, expect, it } from "vitest";
import { throwIfAborted } from "./abortSignal";

describe("portable abort checks", () => {
  it("supports signals without throwIfAborted or reason", () => {
    const controller = new AbortController();
    Object.defineProperties(controller.signal, {
      throwIfAborted: { value: undefined },
      reason: { value: undefined },
    });
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(
      expect.objectContaining({ name: "AbortError" }),
    );
  });

  it("preserves an explicit abort reason", () => {
    const controller = new AbortController();
    const reason = new Error("connection replaced");
    controller.abort(reason);
    expect(() => throwIfAborted(controller.signal)).toThrow(reason);
  });

  it("allows operations without a signal", () => {
    expect(() => throwIfAborted()).not.toThrow();
  });
});
