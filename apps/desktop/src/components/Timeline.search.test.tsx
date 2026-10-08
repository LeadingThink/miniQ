// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../types";
import { Timeline } from "./Timeline";
import { findHitElement, matchRanges, searchHits } from "../sessionSearch";

const noop = () => undefined;
const asyncNoop = async () => undefined;

afterEach(cleanup);

function message(id: string, role: "user" | "assistant", content: string, second: number): Message {
  return {
    id,
    sessionId: "session-1",
    role,
    content,
    createdAt: `2026-09-08T00:00:${String(second).padStart(2, "0")}Z`,
  };
}

const messages = [
  message("m1", "user", "部署 alpha 服务", 0),
  message("m2", "assistant", "alpha 已部署", 1),
  message("m3", "user", "检查 beta", 2),
  message("m4", "assistant", "ALPHA 和 beta 都正常", 3),
];

function renderTimeline(onError = vi.fn()) {
  const view = render(
    <Timeline
      messages={messages}
      toolCalls={[]}
      approvals={[]}
      questions={[]}
      plan={[]}
      artifacts={[]}
      queue={[]}
      streamingText=""
      turnProgress={null}
      busy={false}
      onResolveApproval={noop}
      onResolveQuestion={noop}
      onRollback={noop}
      onOpenFile={noop}
      onOpenUrl={noop}
      onSteerQueued={asyncNoop}
      onRemoveQueued={asyncNoop}
      onUpdateQueued={asyncNoop}
      onRewrite={async () => true}
      onError={onError}
    />,
  );
  return { ...view, onError };
}

describe("session search helpers", () => {
  it("finds case-insensitive text ranges and skips ignored nodes", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>Alpha alpha</p><textarea>alpha</textarea><p data-search-ignore>alpha</p><p>ALPHA</p>";
    expect(matchRanges(root, " alpha ").map((range) => range.toString())).toEqual(["Alpha", "alpha", "ALPHA"]);
    expect(matchRanges(root, "")).toEqual([]);
  });

  it("finds anchored records and records hidden inside folds", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div data-history-anchor="message:a"></div><div data-search-records="tool:t1 tool:t2 message:b"></div>`;
    expect(findHitElement(root, { key: "message:a", kind: "message", id: "a" })).toBe(root.firstChild);
    expect(findHitElement(root, { key: "tool:t2", kind: "tool", id: "t2" })).toBe(root.lastChild);
    expect(findHitElement(root, { key: "message:b", kind: "message", id: "b" })).toBe(root.lastChild);
    expect(findHitElement(root, { key: "tool:t3", kind: "tool", id: "t3" })).toBeNull();
  });

  it("maps groups to stable hit keys", () => {
    expect(searchHits([{ kind: "message", at: "", message: messages[0] }]))
      .toEqual([{ key: "message:m1", kind: "message", id: "m1" }]);
  });
});

describe("Timeline find in conversation", () => {
  it("counts matches, starts at the newest and steps with Enter", () => {
    renderTimeline();
    const input = screen.getByRole("searchbox", { name: "搜索当前会话" });
    fireEvent.change(input, { target: { value: "alpha" } });
    expect(screen.getByText("3 / 3")).toBeTruthy();
    const current = () => document.querySelector("[data-search-current]")?.getAttribute("data-history-anchor");
    expect(current()).toBe("message:m4");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("2 / 3")).toBeTruthy();
    expect(current()).toBe("message:m2");
    fireEvent.click(screen.getByRole("button", { name: "上一个结果" }));
    expect(current()).toBe("message:m1");
    // Wrap around to the newest match.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(current()).toBe("message:m4");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(current()).toBe("message:m1");
    fireEvent.click(screen.getByRole("button", { name: "下一个结果" }));
    expect(current()).toBe("message:m2");
  });

  it("reports no matches and Escape clears the query", () => {
    renderTimeline();
    const input = screen.getByRole("searchbox", { name: "搜索当前会话" }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "gamma" } });
    expect(screen.getByText("无匹配")).toBeTruthy();
    expect((screen.getByRole("button", { name: "上一个结果" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(screen.queryByRole("group", { name: "搜索结果导航" })).toBeNull();
  });

  it("shows the selected match in the full conversation", async () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout"] });
    try {
      renderTimeline();
      const input = screen.getByRole("searchbox", { name: "搜索当前会话" }) as HTMLInputElement;
      fireEvent.change(input, { target: { value: "beta" } });
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.click(screen.getByRole("button", { name: /查看上下文/ }));
      expect(input.value).toBe("");
      act(() => { vi.advanceTimersByTime(20); });
      expect(document.querySelectorAll("[data-history-anchor^='message:']").length).toBe(4);
      expect(document.querySelector("[data-search-located]")?.getAttribute("data-history-anchor")).toBe("message:m3");
    } finally {
      vi.useRealTimers();
    }
  });
});
