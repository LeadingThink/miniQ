// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RetryNotice } from "./RetryNotice";
import { ExecutionPrelude, turnProgressLabel } from "./ExecutionActivity";
import type { TurnProgress } from "../types";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("keeps retry counts visible throughout requests, responses and compaction", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-07T00:00:00Z"));
  const progress: TurnProgress = {
    phase: "waiting_retry", startedAt: new Date().toISOString(), modelStep: 4,
    retry: { attempt: 3, maxAttempts: 10, delayMs: 4_000 },
  };
  const view = render(<ExecutionPrelude plan={[]} progress={progress} />);
  expect(screen.getByText(/自动重试 3\/10.*4 秒后重试/)).toBeTruthy();
  for (const [phase, label] of [["requesting_model", "正在恢复请求"], ["receiving_model", "正在接收响应"], ["compacting_context", "正在压缩上下文"]] as const) {
    view.rerender(<ExecutionPrelude plan={[]} progress={{ ...progress, phase, retry: { ...progress.retry!, delayMs: 0 } }} />);
    act(() => vi.advanceTimersByTime(95_000));
    expect(screen.getByText(new RegExp(`自动重试 3/10.*${label}`))).toBeTruthy();
  }
  view.rerender(<ExecutionPrelude plan={[]} progress={{ ...progress, phase: "requesting_model", modelStep: 5, retry: undefined }} />);
  expect(screen.queryByText(/自动重试 3\/10/)).toBeNull();
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
