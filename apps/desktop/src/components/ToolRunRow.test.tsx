// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ToolCall } from "../types";
import { ToolRunRow } from "./ToolRunRow";
import { toolRuns } from "./toolSummary";

afterEach(cleanup);
const call = (id: string, name: string, status: ToolCall["status"] = "succeeded"): ToolCall => ({
  id, sessionId: "s", toolName: name, status, input: { path: `${id}.ts` }, createdAt: "2026-10-14T00:00:00Z",
});
const props = { focusId: null, stepExpanded: () => false };

it("merges mixed exploration, reveals all calls, and stops animating on completion", () => {
  const calls = [call("a", "file_read"), call("b", "file_list"), call("c", "file_grep", "running")];
  const view = render(<ToolRunRow run={toolRuns(calls)[0]} {...props} />);
  expect(screen.getByText("正在探索")).toBeTruthy();
  expect(view.container.querySelectorAll(".tool-run-shimmer")).toHaveLength(1);
  expect(view.container.querySelector(".tool-run-steps")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /正在探索/ }));
  expect(view.container.querySelectorAll(".tool-run-steps > [data-history-anchor]")).toHaveLength(3);
  view.rerender(<ToolRunRow run={toolRuns(calls.map(c => ({ ...c, status: "succeeded" })))[0]} {...props} />);
  expect(screen.getByText("已探索")).toBeTruthy();
  expect(view.container.querySelector(".tool-run-shimmer")).toBeNull();
  expect(view.container.querySelectorAll(".tool-run-steps > [data-history-anchor]")).toHaveLength(3);
});

it("keeps a manually opened group open as calls append, and exposes failures while collapsed", () => {
  const calls = [call("a", "file_read"), call("b", "file_read", "failed")];
  const view = render(<ToolRunRow run={toolRuns(calls)[0]} {...props} />);
  expect(screen.getByText("1 项未成功")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /已探索/ }));
  view.rerender(<ToolRunRow run={toolRuns([...calls, call("c", "file_read", "running")])[0]} {...props} />);
  expect(view.container.querySelectorAll(".tool-run-steps > [data-history-anchor]")).toHaveLength(3);
});

it("shows approval without pretending the tool is running and honors search expansion", () => {
  const calls = [call("a", "file_read"), call("b", "file_read", "waiting_approval")];
  const view = render(<ToolRunRow run={toolRuns(calls)[0]} {...props} />);
  expect(screen.getByText("探索等待确认")).toBeTruthy();
  expect(view.container.querySelector(".tool-run-shimmer")).toBeNull();
  view.rerender(<ToolRunRow run={toolRuns(calls.map(c => ({ ...c, status: "succeeded" })))[0]} {...props} expanded />);
  expect(view.container.querySelectorAll(".tool-run-steps > [data-history-anchor]")).toHaveLength(2);
});
