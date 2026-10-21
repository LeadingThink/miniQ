// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ExecutionEventRecord } from "../modelDiagnostics";
import { ExecutionEvent } from "./ExecutionEvent";

afterEach(cleanup);

const outcome: ExecutionEventRecord = {
  id: "outcome-1",
  sessionId: "session-1",
  createdAt: "2026-10-21T00:00:00Z",
  type: "turn_outcome",
  data: { anchorMessageId: "message-1", status: "failed" },
};

it("shows the retained failure reason for an earlier turn without opening raw event details", () => {
  const error = "Anthropic Messages API error:\nThe request timed out while trying to download the file.\nrequest id: request-1";
  const { container } = render(<ExecutionEvent event={{ ...outcome, data: { ...outcome.data, error } }} />);
  const reason = container.querySelector(".model-call-error");
  expect(reason?.textContent).toBe(error);
  expect(reason?.closest("details")).toBeNull();
  expect(screen.getByText("失败")).toBeTruthy();
});

it("renders legacy outcomes without inventing a failure reason", () => {
  const { container } = render(<ExecutionEvent event={outcome} />);
  expect(screen.getByText("失败")).toBeTruthy();
  expect(container.querySelector(".model-call-error")).toBeNull();
});
