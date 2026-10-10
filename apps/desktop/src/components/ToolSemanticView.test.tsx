// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolCall } from "../types";
import { ToolStep } from "./ExecutionActivity";
import { ToolGroup } from "./ToolGroup";
import { readRangeLabel } from "./ToolSemanticView";

afterEach(cleanup);

let nextId = 0;
function call(toolName: string, input: unknown, output?: unknown, status: ToolCall["status"] = "succeeded"): ToolCall {
  nextId += 1;
  return {
    id: `call-${nextId}`,
    sessionId: "s",
    toolName,
    input,
    output,
    status,
    createdAt: "2026-10-10T00:00:00Z",
    completedAt: status === "running" ? undefined : "2026-10-10T00:00:02Z",
  };
}

function expand(name: RegExp | string) {
  fireEvent.click(screen.getByRole("button", { name }));
}

describe("semantic step views", () => {
  it("shows shell output as a terminal block with the first 20 lines", () => {
    const stdout = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n");
    render(<ToolStep call={call("shell_run", { command: "npm test" }, { stdout, stderr: "warn", exitCode: 1 })} />);
    expand(/运行了\s*npm test/);
    const terminal = screen.getByRole("region", { name: "命令输出" });
    expect(terminal.textContent).toContain("$ npm test");
    expect(terminal.textContent).toContain("line 20");
    expect(terminal.textContent).not.toContain("line 21");
    expect(terminal.textContent).toContain("退出码 1");
    expand("显示全部（26 行）");
    expect(terminal.textContent).toContain("line 25");
    expect(terminal.querySelector(".is-stderr")?.textContent).toBe("warn");
    expect(screen.queryByRole("region", { name: "输入" })).toBeNull();
  });

  it("keeps raw input and output behind 查看详情", () => {
    render(<ToolStep call={call("git_status", {}, { branch: "main-raw" })} />);
    expand(/检查了 Git 状态/);
    expect(screen.queryByText(/main-raw/)).toBeNull();
    expand("查看详情");
    expect(screen.getByRole("region", { name: "结果" }).textContent).toContain("main-raw");
  });

  it("shows a file read as its path and line range", () => {
    render(<ToolStep call={call("file_read", { path: "src/a.ts", offset: 10, limit: 3 }, { path: "src/a.ts", content: "a\nb\nc", totalLines: 40, offset: 10 })} />);
    expand(/读取了\s*src\/a\.ts/);
    expect(screen.getByText("第 10-12 行，共 40 行")).toBeTruthy();
    expect(readRangeLabel({ path: "x", limit: 5 }, undefined)).toBe("第 1-5 行");
    expect(readRangeLabel({ path: "x" }, undefined)).toBe("全文");
  });

  it("shows a file edit as a small inline diff", () => {
    render(<ToolStep call={call("file_edit", { path: "notes.txt", oldString: "keep\nold", newString: "keep\nnew" }, { path: "notes.txt" })} />);
    expand(/编辑了\s*notes\.txt/);
    const diff = screen.getByRole("region", { name: "notes.txt 的改动" });
    expect([...diff.querySelectorAll(".tool-diff-line")].map((line) => line.className)).toEqual([
      "tool-diff-line context", "tool-diff-line deletion", "tool-diff-line addition",
    ]);
    expect(diff.textContent).toContain("+1");
    expect(diff.textContent).toContain("-1");
  });

  it("lists web search results with titles and URLs", () => {
    render(<ToolStep call={call("web_search", { query: "miniq" }, { results: [{ title: "miniQ 文档", url: "https://example.com/docs" }] })} />);
    expand(/搜索了\s*miniq/);
    expect(screen.getByRole("link", { name: "miniQ 文档" }).getAttribute("href")).toBe("https://example.com/docs");
    expect(screen.getByText("1 条结果")).toBeTruthy();
  });

  it("surfaces a failed tool's error without opening the raw payload", () => {
    render(<ToolStep call={call("web_fetch", { url: "https://example.com" }, { error: "timeout" }, "failed")} />);
    expect(screen.getByRole("alert").textContent).toBe("timeout");
  });
});

describe("merged tool runs", () => {
  it("collapses adjacent same-kind calls and expands to individual steps", () => {
    render(<ToolGroup onRollback={vi.fn()} expanded calls={[
      call("file_read", { path: "a.ts" }),
      call("file_read", { path: "b.ts" }),
      call("shell_run", { command: "npm test" }),
    ]} />);
    const run = screen.getByRole("button", { name: /读取了 2 个文件/ });
    expect(run.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(run);
    expect(screen.getByRole("button", { name: /读取了\s*a\.ts/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /读取了\s*b\.ts/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /运行了\s*npm test/ })).toBeTruthy();
  });

  it("shows the running step with live elapsed time", () => {
    render(<ToolGroup onRollback={vi.fn()} expanded calls={[
      call("shell_run", { command: "npm ci" }),
      { ...call("shell_run", { command: "npm test" }, undefined, "running"), createdAt: new Date(Date.now() - 3_000).toISOString() },
    ]} />);
    const run = screen.getByRole("button", { name: /正在运行\s*npm test/ });
    expect(run.textContent).toContain("2 步");
    expect(run.querySelector(".tool-duration")?.textContent).toMatch(/秒/);
  });

  it("auto-expands a run with a live failure or approval and locates the failed step", async () => {
    render(<ToolGroup onRollback={vi.fn()} expanded calls={[
      call("file_read", { path: "a.ts" }),
      call("file_read", { path: "b.ts" }, { error: "missing" }, "failed"),
      call("shell_run", { command: "rm -rf build" }, undefined, "waiting_approval"),
      call("shell_run", { command: "ls" }, undefined, "pending"),
    ]} />);
    expect(screen.getByRole("button", { name: /读取了 2 个文件/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("missing");
    const approval = screen.getAllByRole("button", { name: /正在运行\s*rm -rf build/ });
    expect(approval).toHaveLength(2);
    expect(approval[0].getAttribute("aria-expanded")).toBe("true");
    expect(approval[0].textContent).toContain("等待确认");
    fireEvent.click(screen.getByRole("button", { name: /读取了 2 个文件/ }));
    await act(async () => expand("定位失败步骤"));
    await waitFor(() => expect(screen.getByRole("button", { name: /读取了\s*b\.ts/ }).getAttribute("aria-expanded")).toBe("true"));
  });

  it("keeps per-step rollback inside a merged run", () => {
    const onRollback = vi.fn();
    render(<ToolGroup onRollback={onRollback} expanded calls={[
      call("file_edit", { path: "a.ts", oldString: "a", newString: "b" }, { checkpointId: "ckpt-a" }),
      call("file_edit", { path: "b.ts", oldString: "a", newString: "b" }, { checkpointId: "ckpt-b" }),
    ]} />);
    expand(/编辑了 2 个文件/);
    fireEvent.click(screen.getAllByRole("button", { name: /回滚/ })[1]);
    expect(onRollback).toHaveBeenCalledWith("ckpt-b");
  });
});
