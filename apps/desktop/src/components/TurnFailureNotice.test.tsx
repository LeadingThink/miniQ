// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TurnFailureNotice } from "./TurnFailureNotice";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("retains the complete provider failure and copies its diagnostic details", async () => {
  const reason = `provider error: invalid response: Anthropic Messages API error: The request timed out while trying to download the file. Please try again later.\n(request id: ${"fixture-".repeat(1000)})`;
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<TurnFailureNotice outcome={{ anchorMessageId: "user", status: "failed", error: reason }} onError={vi.fn()} />);
  expect(screen.getByRole("alert").textContent).toContain(reason);
  fireEvent.click(screen.getByRole("button", { name: "复制失败详情" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith(reason));
  expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy();
});

it("shows actionable wording while keeping the original error available", () => {
  const reason = "provider error: insufficient_quota (request id: billing-fixture)";
  render(<TurnFailureNotice outcome={{ anchorMessageId: "user", status: "failed", error: reason }} onError={vi.fn()} />);
  expect(screen.getByText("在问 API Key 的余额或调用额度不足，请充值或更换 API Key。")).toBeTruthy();
  expect(screen.getByText("原始错误详情")).toBeTruthy();
  expect(screen.getByText(reason)).toBeTruthy();
});

it.each([
  { anchorMessageId: "user", status: "completed" },
  { anchorMessageId: "user", status: "cancelled", error: "cancelled" },
  { anchorMessageId: "user", status: "paused", error: "cancelled" },
  { anchorMessageId: "user", status: "failed", error: "cancelled" },
])("does not label a $status outcome as a task failure", (outcome) => {
  const { container } = render(<TurnFailureNotice outcome={outcome} onError={vi.fn()} />);
  expect(container.childElementCount).toBe(0);
});

it("does not invent a reason for a failure recorded by an older daemon", () => {
  render(<TurnFailureNotice outcome={{ anchorMessageId: "user", status: "failed" }} onError={vi.fn()} />);
  expect(screen.getByText("当前记录没有保存具体失败原因。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "复制失败详情" })).toBeNull();
});
