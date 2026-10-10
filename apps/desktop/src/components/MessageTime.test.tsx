// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MessageTime } from "./MessageTime";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

it("makes precise time accessible to touch and keyboard, and omits invalid legacy dates", () => {
  const { container, rerender } = render(<MessageTime at="2026-09-20T10:00:00Z" />);
  expect(container.querySelector("details > summary > time")?.getAttribute("datetime")).toBe("2026-09-20T10:00:00Z");
  expect(container.querySelector("summary")?.getAttribute("aria-label")).toContain("查看完整时间");
  rerender(<MessageTime at="invalid" />);
  expect(container.innerHTML).toBe("");
});

it("shares one calendar timer across history rows and refreshes relative labels at midnight", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 20, 23, 59, 59));
  const at = new Date(2026, 8, 20, 10, 0).toISOString();
  const { container, unmount } = render(<>{Array.from({ length: 100 }, (_, i) => <MessageTime key={i} at={at} />)}</>);
  expect(vi.getTimerCount()).toBe(1);
  expect(container.querySelector("summary time")?.textContent).toBe("10:00");
  act(() => { vi.advanceTimersByTime(1100); });
  expect(container.querySelector("summary time")?.textContent).toBe("昨天 10:00");
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
