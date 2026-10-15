// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TurnActivityTail } from "./TurnActivityTail";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("times the current phase and resets for a new request, retry or finalization", () => {
  vi.useFakeTimers({ toFake: ["Date", "performance", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-15T00:01:23Z"));
  const progress = { phase: "requesting_model" as const, modelStep: 1, startedAt: "2026-10-15T00:01:20Z" };
  const view = render(<TurnActivityTail progress={progress} />);
  const tail = () => screen.getByLabelText("本轮尚未结束").textContent;
  expect(tail()).toContain("Thinking…（已运行 3秒）");
  act(() => vi.advanceTimersByTime(2000));
  expect(tail()).toContain("已运行 5秒");
  view.rerender(<TurnActivityTail progress={{ ...progress, modelStep: 2, startedAt: new Date().toISOString() }} />);
  expect(tail()).toContain("已运行 不足1秒");
  act(() => vi.advanceTimersByTime(3000));
  expect(tail()).toContain("已运行 3秒");
  view.rerender(<TurnActivityTail progress={{ phase: "waiting_retry", startedAt: new Date().toISOString(), retry: { attempt: 1, maxAttempts: 10, delayMs: 1000 } }} />);
  expect(tail()).toContain("Retrying…（已运行 不足1秒）");
  act(() => vi.advanceTimersByTime(2000));
  view.rerender(<TurnActivityTail progress={{ phase: "finalizing", startedAt: new Date().toISOString() }} />);
  expect(tail()).toContain("Finishing…（已运行 不足1秒）");
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not invent a clock when phase timing is absent or invalid", () => {
  const view = render(<TurnActivityTail />);
  expect(screen.getByLabelText("本轮尚未结束").textContent).not.toContain("（");
  view.rerender(<TurnActivityTail progress={{ phase: "requesting_model", startedAt: "invalid" }} />);
  expect(screen.getByLabelText("本轮尚未结束").textContent).not.toContain("（");
});
