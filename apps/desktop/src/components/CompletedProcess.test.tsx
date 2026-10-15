// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { CompletedProcess } from "./CompletedProcess";

afterEach(cleanup);
it("uses persisted duration and distinguishes failure and cancellation", () => {
  const base = { startedAt: "2026-10-14T00:00:00Z", elapsedMs: 98000 };
  const view = render(<CompletedProcess recordKeys="tool:a" timing={{ ...base, status: "failed" }}>过程</CompletedProcess>);
  expect(screen.getByText("已工作 1分38秒 · 未完成")).toBeTruthy();
  expect(view.container.querySelector("details")?.open).toBe(false);
  view.rerender(<CompletedProcess recordKeys="tool:a" timing={{ ...base, status: "cancelled" }}>过程</CompletedProcess>);
  expect(screen.getByText("已工作 1分38秒 · 已停止")).toBeTruthy();
});
it("derives duration only from recorded endpoints, not current wall time", () => {
  const { container } = render(<CompletedProcess recordKeys="" timing={{ status: "completed", startedAt: "2026-10-14T00:00:00Z", completedAt: "2026-10-14T00:00:15Z" }}>过程</CompletedProcess>);
  expect(container.querySelector("summary")?.textContent).toBe("已工作 15秒");
});
