// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../types";
import { SidebarAttention } from "./SidebarAttention";

const base: Session = {
  id: "idle", workspaceId: "w1", workingDirectory: "/work/one", title: "普通会话", status: "idle",
  pinned: false, archived: false, createdAt: "2026-09-03T00:00:00Z", updatedAt: "2026-09-03T00:00:00Z",
};

afterEach(cleanup);

describe("SidebarAttention", () => {
  it("shows priority counts, excludes archived/read sessions, and keeps the complete list expandable", () => {
    const sessions = [
      { ...base, id: "unread", title: "新回复" },
      { ...base, id: "failed", title: "失败任务", status: "failed" as const },
      { ...base, id: "waiting", title: "审批任务", status: "waiting_approval" as const },
      { ...base, id: "archived", title: "归档任务", archived: true },
      { ...base, id: "archived-waiting", title: "归档审批", archived: true, status: "waiting_approval" as const },
      { ...base, id: "archived-failed", title: "归档失败", archived: true, status: "failed" as const },
      base,
    ];
    render(<SidebarAttention sessions={sessions} unreadSessionIds={new Set(["unread", "archived"])} workspaceLabels={new Map([["w1", "本机 · 项目一"]])} onSelectSession={vi.fn()} />);
    const summary = screen.getByRole("button", { name: /待处理/ });
    expect(summary.textContent).toContain("2");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("list", { name: "待处理会话" }).id).toBe(summary.getAttribute("aria-controls"));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByRole("button", { name: /审批任务/ }).tagName).toBe("BUTTON");
    expect(screen.getAllByText("本机 · 项目一")[0]).toBeTruthy();
    expect(screen.queryByText("归档任务")).toBeNull();
    expect(screen.queryByText("归档审批")).toBeNull();
    expect(screen.queryByText("归档失败")).toBeNull();
    expect(screen.queryByText("普通会话")).toBeNull();
    expect(screen.getAllByRole("listitem")[0].textContent).toContain("审批任务");
  });

  it("selects a session and closes the mobile sidebar through the existing callback", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<SidebarAttention sessions={[{ ...base, id: "waiting", title: "普通会话", status: "waiting_approval" }]} unreadSessionIds={new Set()} workspaceLabels={new Map()} onSelectSession={onSelect} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /待处理/ }));
    fireEvent.click(screen.getByRole("button", { name: /普通会话/ }));
    expect(onSelect).toHaveBeenCalledWith("waiting");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
