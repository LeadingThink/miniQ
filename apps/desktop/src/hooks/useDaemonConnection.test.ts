import { describe, expect, it } from "vitest";
import { connectionRetryDelay } from "./useDaemonConnection";

describe("connectionRetryDelay", () => {
  it("backs off quickly and caps reconnect latency", () => {
    expect([1, 2, 3, 4, 5, 6].map(connectionRetryDelay)).toEqual([
      500, 1_000, 2_000, 4_000, 5_000, 5_000,
    ]);
  });
});
