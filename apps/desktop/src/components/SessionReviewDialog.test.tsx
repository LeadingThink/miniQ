// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReviewRun } from "../sessionReview";
import { REVIEW_MODEL_KEY, SessionReviewDialog } from "./SessionReviewDialog";

vi.mock("./ui/Dialog", () => ({
  Dialog: (props: { open: boolean; title: string; children?: React.ReactNode; footer?: React.ReactNode }) => props.open ? <div role="dialog" aria-label={props.title}>{props.children}{props.footer}</div> : null,
  ConfirmDialog: (props: { open: boolean; title: string; onConfirm: () => void; onCancel: () => void }) => props.open ? <div role="alertdialog" aria-label={props.title}><button onClick={props.onConfirm}>确认发送修订反馈</button><button onClick={props.onCancel}>取消</button></div> : null,
}));
vi.mock("./ui/Toast", () => ({ useToast: () => ({ available: false, show: vi.fn() }) }));

afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); });
beforeEach(() => { localStorage.clear(); });

const evidence = { id: "e1", kind: "quote", title: "原文", text: "可核验原文" };
function run(overrides: Partial<ReviewRun> = {}): ReviewRun {
  return { id: "r1", sessionId: "s1", primaryMessageId: "a1", model: "review-model", status: "completed", verdict: "issues_found", findings: [{ severity: "important", claim: "需要核实", evidenceIds: ["e1"], recommendation: "修订" }], limitations: [], evidence: [evidence], error: null, inputTokens: 10, outputTokens: 5, createdAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:01:00Z", ...overrides };
}
function client(call: (method: string, params?: unknown, options?: unknown) => Promise<unknown>) {
  return { call, connected: true, storageScope: "test", onStatus: () => () => undefined } as never;
}
function baseCalls(reviewRuns: ReviewRun[] = [run()]) {
  return vi.fn<(method: string, params?: unknown, options?: unknown) => Promise<any>>(async (method: string) => {
    if (method === "review.list") return { runs: reviewRuns };
    if (method === "model.list") return { models: ["primary-model", "review-model"] };
    if (method === "session.modelGet") return { settings: { model: null, apiProtocol: "auto", reasoningEffort: null }, effective: { model: "primary-model", apiProtocol: "auto", reasoningEffort: null } };
    if (method === "review.get") return { run: reviewRuns[0] };
    throw new Error(`unexpected ${method}`);
  });
}

it("keeps the main model unchanged and stores review selection separately", async () => {
  const calls = baseCalls([]);
  render(<SessionReviewDialog client={client(calls)} sessionId="s1" primaryMessageId="a1" busy={false} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("option", { name: "review-model" })).toBeTruthy());
  fireEvent.change(screen.getByRole("combobox", { name: "审查模型" }), { target: { value: "review-model" } });
  expect(localStorage.getItem(REVIEW_MODEL_KEY)).toBe("review-model");
  expect(screen.getByText(/当前主模型：primary-model/)).toBeTruthy();
  expect(calls).not.toHaveBeenCalledWith("session.modelUpdate", expect.anything(), expect.anything());
});

it("polls queued runs and cleans up when the dialog closes", async () => {
  let current = run({ status: "queued", verdict: null, findings: [] });
  const calls = vi.fn(async (method: string) => {
    if (method === "review.list") return { runs: [current] };
    if (method === "model.list") return { models: ["review-model"] };
    if (method === "session.modelGet") return { settings: { model: null, apiProtocol: "auto", reasoningEffort: null }, effective: { model: "primary-model", apiProtocol: "auto", reasoningEffort: null } };
    if (method === "review.get") return { run: current };
    throw new Error(`unexpected ${method}`);
  });
  const view = render(<SessionReviewDialog client={client(calls)} sessionId="s1" primaryMessageId="a1" busy={false} onClose={vi.fn()} />);
  const getCount = () => calls.mock.calls.filter(([method]) => method === "review.get").length;
  await waitFor(() => expect(getCount()).toBe(1));
  expect(getCount()).toBe(1);
  view.unmount();
  await new Promise((resolve) => setTimeout(resolve, 1600));
  expect(getCount()).toBe(1);
});

it("shows daemon method errors as a manual retry and renders evidence links", async () => {
  const calls = vi.fn(async (method: string) => {
    if (method === "review.list") throw new Error("-32601 method not found");
    if (method === "model.list") return { models: ["review-model"] };
    if (method === "session.modelGet") return { effective: { model: "primary-model" } };
    throw new Error("unexpected");
  });
  render(<SessionReviewDialog client={client(calls)} sessionId="s1" primaryMessageId="a1" busy={false} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("不支持第二意见"));
  expect(screen.getByRole("button", { name: /手动重试/ })).toBeTruthy();

  cleanup();
  const reportCalls = baseCalls();
  render(<SessionReviewDialog client={client(reportCalls)} sessionId="s1" primaryMessageId="a1" busy={false} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByText("需要核实")).toBeTruthy());
  fireEvent.click(screen.getByRole("link", { name: /证据：原文/ }));
  expect(screen.getByText("可核验原文")).toBeTruthy();
});

it("requires explicit confirmation and sends one new user message", async () => {
  const calls = baseCalls();
  calls.mockImplementation(async (method: string, _params?: unknown) => {
    if (method === "review.list") return { runs: [run()] };
    if (method === "model.list") return { models: ["review-model"] };
    if (method === "session.modelGet") return { effective: { model: "primary-model" } };
    if (method === "session.history") return { messages: [], nextCursor: null };
    if (method === "session.sendMessage") return { message: { id: "u2" } };
    if (method === "review.get") return { run: run() };
    throw new Error(`unexpected ${method}`);
  });
  render(<SessionReviewDialog client={client(calls)} sessionId="s1" primaryMessageId="a1" busy={false} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByText("交给主模型修订一次")).toBeTruthy());
  fireEvent.click(screen.getByText("交给主模型修订一次"));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  expect(calls).not.toHaveBeenCalledWith("session.sendMessage", expect.anything(), expect.anything());
  fireEvent.click(screen.getByRole("button", { name: "确认发送修订反馈" }));
  await waitFor(() => expect(calls).toHaveBeenCalledWith("session.sendMessage", expect.objectContaining({ sessionId: "s1", message: expect.objectContaining({ role: "user" }), rejectIfBusy: true })));
  expect(localStorage.getItem("miniq.sessionReview.revision:[\"test\",null,\"s1\",\"a1\"]")).toContain('"sent"');
});

it("uses the backend-registered review RPCs with exact start/get/cancel parameters", async () => {
  const { readFileSync } = await import("node:fs");
  const gateway = readFileSync("../../crates/miniq-daemon/src/gateway.rs", "utf8");
  let current = run({ status: "queued", verdict: null, findings: [] });
  const calls = baseCalls([]);
  const base = calls.getMockImplementation()!;
  calls.mockImplementation(async (method, params, options) => {
    if (method.startsWith("review.")) expect(gateway).toContain(`"${method}" => review::`);
    if (method === "review.start") return { run: current };
    if (method === "review.get") return { run: current };
    if (method === "review.cancel") { current = { ...current, status: "cancelled" }; return { run: current }; }
    return base(method, params, options);
  });
  render(<SessionReviewDialog client={client(calls)} sessionId="s1" primaryMessageId="a1" busy={false} onClose={vi.fn()} />);
  await screen.findByRole("option", { name: "review-model" });
  expect(calls).toHaveBeenCalledWith("review.list", { sessionId: "s1", primaryMessageId: "a1" }, expect.anything());
  fireEvent.change(screen.getByRole("combobox", { name: "审查模型" }), { target: { value: "review-model" } });
  fireEvent.click(screen.getByRole("button", { name: "检查本轮答复" }));
  await screen.findByRole("button", { name: "取消检查" });
  expect(calls).toHaveBeenCalledWith("review.start", { sessionId: "s1", primaryMessageId: "a1", model: "review-model" });
  await waitFor(() => expect(calls).toHaveBeenCalledWith("review.get", { sessionId: "s1", reviewId: "r1" }, expect.anything()));
  fireEvent.click(screen.getByRole("button", { name: "取消检查" }));
  await waitFor(() => expect(calls).toHaveBeenCalledWith("review.cancel", { sessionId: "s1", reviewId: "r1" }));
  expect(calls.mock.calls.some(([method]) => method === "session.modelUpdate")).toBe(false);
});
