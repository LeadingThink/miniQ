// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ToolCall } from "../types";
import { ToolSegment } from "./ToolSegment";

vi.mock("./Md", () => ({ Md: ({ children }: { children: string }) => <p>{children}</p> }));
afterEach(cleanup);
const call = (id: string, toolName: string, input: unknown, status: ToolCall["status"] = "succeeded"): ToolCall =>
  ({ id, sessionId: "s", toolName, input, status, createdAt: "2026-10-14T00:00:00Z" });

it("renders a closed one-line summary and mounts steps only when opened", async () => {
  const calls = [call("a", "file_read", { path: "a.ts" }), call("b", "shell_run", { command: "npm test" }, "failed")];
  const { container } = render(<ToolSegment calls={calls} expanded={false} />);
  const segment = container.querySelector<HTMLDetailsElement>(".tool-segment")!;
  expect(segment.open).toBe(false);
  expect(segment.dataset.historyAnchor).toBe("tool:a");
  expect(segment.dataset.searchRecords).toBe("tool:a tool:b");
  expect(segment.querySelector(".tool-segment-label")?.textContent).toBe("已探索 1 项，运行了 1 条命令");
  expect(segment.querySelector(".tool-segment-state.failed")?.textContent).toBe("1 项未成功");
  expect(segment.querySelector("[data-lazy-body]")).toBeNull();
  fireEvent.click(segment.querySelector("summary")!);
  await waitFor(() => expect(segment.querySelector("[data-lazy-body]")).toBeTruthy());
  expect(segment.querySelector('[data-history-anchor="tool:b"]')).toBeTruthy();
});

it("names the active call and starts open when groups are expanded", () => {
  const calls = [call("a", "file_read", { path: "a.ts" }), call("b", "shell_run", { command: "npm test" }, "running")];
  const { container } = render(<ToolSegment calls={calls} expanded />);
  const segment = container.querySelector<HTMLDetailsElement>(".tool-segment")!;
  expect(segment.open).toBe(true);
  expect(segment.getAttribute("aria-live")).toBe("polite");
  expect(segment.querySelector(".tool-segment-label")?.textContent).toBe("正在运行 npm test");
  expect(segment.querySelector("[data-lazy-body]")).toBeTruthy();
});
