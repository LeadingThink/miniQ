// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RetryNotice } from "./RetryNotice";
import { turnProgressLabel } from "./ExecutionActivity";
import type { TurnProgress } from "../types";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("shows a retry countdown and clears its timer on unmount", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T00:00:00Z"));
  const progress: TurnProgress = {
    phase: "waiting_retry",
    startedAt: new Date().toISOString(),
    modelStep: 2,
    retry: { attempt: 1, maxAttempts: 4, delayMs: 2_000 },
  };
  expect(turnProgressLabel(progress)).toContain("自动重试");
  const view = render(<RetryNotice progress={progress} />);
  expect(screen.getByText(/自动重试 1\/4.*2 秒后重试/)).toBeTruthy();
  act(() => vi.advanceTimersByTime(2_000));
  expect(screen.getByText(/正在恢复请求/)).toBeTruthy();
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
