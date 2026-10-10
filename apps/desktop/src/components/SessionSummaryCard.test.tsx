// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { SessionSummaryCard, type SessionSummaryCardProps, type SessionSummarySection } from "./SessionSummaryCard";
import type { AgentSummary } from "./AgentSummary";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const emptyDiff = { files: [], additions: 0, deletions: 0 };

function agent(agentId: string, status: string): AgentSummary {
  return { agentId, name: agentId, status } as AgentSummary;
}

function Harness(props: Partial<SessionSummaryCardProps>) {
  const [expanded, setExpanded] = useState<SessionSummarySection | null>(null);
  return (
    <SessionSummaryCard
      diff={emptyDiff}
      agents={[]}
      sources={[]}
      pullRequests={[]}
      onOpenReview={() => undefined}
      onOpenUrl={() => undefined}
      agentPanel={<div>agent panel</div>}
      {...props}
      expanded={expanded}
      onExpandedChange={setExpanded}
    />
  );
}

it("renders nothing when every section is empty", () => {
  const { container } = render(<Harness />);
  expect(container.firstChild).toBeNull();
});

it("shows only non-empty sections", () => {
  const onOpenReview = vi.fn();
  render(<Harness diff={{ files: [{}], additions: 12, deletions: 3 }} onOpenReview={onOpenReview} />);
  expect(screen.getByText("变更")).toBeTruthy();
  expect(screen.getByText("+12")).toBeTruthy();
  expect(screen.getByText("-3")).toBeTruthy();
  expect(screen.queryByText("子智能体")).toBeNull();
  expect(screen.queryByText("来源")).toBeNull();
  expect(screen.queryByText("拉取请求")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /变更/ }));
  expect(onOpenReview).toHaveBeenCalledTimes(1);
});

it("summarizes child agents and expands the full agent panel", () => {
  render(<Harness agents={[agent("a", "completed"), agent("b", "running"), agent("c", "failed")]} />);
  const button = screen.getByRole("button", { name: /子智能体/ });
  expect(button.textContent).toContain("1 完成 / 1 进行中");
  expect(screen.queryByText("agent panel")).toBeNull();
  fireEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("agent panel")).toBeTruthy();
});

it("lists sources and pull requests and opens them in the embedded browser", () => {
  const onOpenUrl = vi.fn();
  render(
    <Harness
      onOpenUrl={onOpenUrl}
      sources={[{ url: "https://example.com/a", title: "Example", domain: "example.com", via: "visited" }]}
      pullRequests={[{ url: "https://github.com/o/r/pull/7", owner: "o", repo: "r", number: 7 }]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /来源/ }));
  fireEvent.click(screen.getByRole("button", { name: /Example/ }));
  expect(onOpenUrl).toHaveBeenLastCalledWith("https://example.com/a");
  fireEvent.click(screen.getByRole("button", { name: /拉取请求/ }));
  expect(screen.queryByText("Example")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /#7/ }));
  expect(onOpenUrl).toHaveBeenLastCalledWith("https://github.com/o/r/pull/7");
});

it("remembers the collapsed state", () => {
  render(<Harness diff={{ files: [{}], additions: 1, deletions: 0 }} />);
  fireEvent.click(screen.getByRole("button", { name: "收起会话摘要" }));
  expect(window.localStorage.getItem("miniq.sessionSummary.collapsed")).toBe("1");
  cleanup();
  render(<Harness diff={{ files: [{}], additions: 1, deletions: 0 }} />);
  expect(screen.getByRole("button", { name: "展开会话摘要" })).toBeTruthy();
});
