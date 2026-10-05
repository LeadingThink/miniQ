import { afterEach, describe, expect, it, vi } from "vitest";
import { sendRaw, type OutboundSocket } from "./outbound.js";
import { DESKTOP_RATE, ObjectByteBudget, TokenBucket } from "./rateLimit.js";

afterEach(() => vi.restoreAllMocks());

function fakeSocket(bufferedAmount: number) {
  return { readyState: 1, OPEN: 1, bufferedAmount, send: vi.fn(), terminate: vi.fn() } as unknown as OutboundSocket & {
    send: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  };
}

describe("relay outbound backpressure", () => {
  it("sends while the peer's buffer is under the limit", () => {
    const socket = fakeSocket(1024);
    sendRaw(socket, "payload", 2048);
    expect(socket.send).toHaveBeenCalledWith("payload");
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it("terminates a slow peer instead of buffering past the limit", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const socket = fakeSocket(4096);
    sendRaw(socket, "payload", 2048);
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.terminate).toHaveBeenCalledOnce();
  });
});

describe("relay rate limits", () => {
  it("allows a desktop burst, then refills at the sustained rate", () => {
    const bucket = new TokenBucket(DESKTOP_RATE, 0);
    let allowed = 0;
    for (let i = 0; i < DESKTOP_RATE.burst + 50; i += 1) if (bucket.take(0)) allowed += 1;
    expect(allowed).toBe(DESKTOP_RATE.burst);
    expect(bucket.take(0)).toBe(false);
    let refilled = 0;
    for (let i = 0; i < 100; i += 1) if (bucket.take(1000)) refilled += 1;
    expect(refilled).toBe(DESKTOP_RATE.perSecond);
    expect(DESKTOP_RATE.perSecond).toBeGreaterThanOrEqual(20);
  });

  it("caps object ticket bytes per minute", () => {
    const budget = new ObjectByteBudget(0);
    expect(budget.reserve(100 * 1024 * 1024, 0)).toBe(true);
    expect(budget.reserve(64 * 1024 * 1024, 1000)).toBe(false);
    expect(budget.reserve(64 * 1024 * 1024, 60_000)).toBe(true);
  });
});
