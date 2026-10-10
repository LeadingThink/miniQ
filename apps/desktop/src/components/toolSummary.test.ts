import { describe, expect, it } from "vitest";
import type { ToolCall } from "../types";
import { patchPaths, toolRunSummary, toolRuns, toolStepTitle } from "./toolSummary";
import { additionLines, lineDiff, operationDiffLines, parseCodexPatch } from "./lineDiff";

let nextId = 0;
function call(toolName: string, input: unknown, status: ToolCall["status"] = "succeeded"): ToolCall {
  nextId += 1;
  return { id: `call-${nextId}`, sessionId: "s", toolName, input, status, createdAt: "2026-10-10T00:00:00Z" };
}

describe("tool run summaries", () => {
  it("merges adjacent same-kind calls into one natural-language line", () => {
    const runs = toolRuns([
      call("file_read", { path: "a.ts" }),
      call("file_read", { path: "b.ts" }),
      call("doc_read", { path: "c.pdf" }),
      call("shell_run", { command: "npm test" }),
      call("shell_batch", { commands: ["git status", "git diff"] }),
      call("web_search", { query: "vite" }),
      call("web_search", { query: "vitest" }),
      call("file_edit", { path: "a.ts" }),
      call("file_write", { path: "d.ts" }),
      call("apply_patch", { patch: "*** Begin Patch\n*** Update File: e.ts\n*** Add File: f.ts\n*** End Patch" }),
      call("git_status", {}),
      call("git_status", {}),
    ]);
    expect(runs.map(toolRunSummary)).toEqual([
      "读取了 3 个文件",
      "运行了 3 条命令",
      "搜索了 2 次网页",
      "编辑了 4 个文件",
      "",
      "",
    ]);
  });

  it("counts distinct files and keeps automation and unknown tools separate", () => {
    const runs = toolRuns([
      call("file_read", { path: "a.ts" }),
      call("file_read", { path: "a.ts" }),
      call("computer_use", { action: "click" }),
      call("computer_use", { action: "screenshot" }),
    ]);
    expect(runs.map((run) => run.calls.length)).toEqual([2, 1, 1]);
    expect(toolRunSummary(runs[0])).toBe("读取了 1 个文件");
  });

  it("counts historical calls without payloads as one target each", () => {
    const runs = toolRuns([call("file_read", null), call("file_read", null), call("shell_run", null)]);
    expect(runs.map(toolRunSummary)).toEqual(["读取了 2 个文件", "运行了 1 条命令"]);
  });

  it("names running and finished steps with their target", () => {
    expect(toolStepTitle(call("shell_run", { command: "npm test" }, "running"), true)).toEqual({ verb: "正在运行", target: "npm test" });
    expect(toolStepTitle(call("file_read", { path: "src/a.ts" }), false)).toEqual({ verb: "读取了", target: "src/a.ts" });
    expect(toolStepTitle(call("shell_batch", { commands: ["a", "b"] }), false)).toEqual({ verb: "运行了", target: "a 等 2 项" });
    expect(toolStepTitle(call("file_read", null), false)).toBeNull();
    expect(toolStepTitle(call("git_status", {}), false)).toBeNull();
  });

  it("reads apply_patch targets from both input shapes", () => {
    expect(patchPaths({ operation: { type: "update_file", path: "x.rs", diff: "" } })).toEqual(["x.rs"]);
    expect(patchPaths({ patch: "*** Begin Patch\n*** Delete File: y.rs\n*** End Patch" })).toEqual(["y.rs"]);
  });
});

describe("inline line diffs", () => {
  it("keeps shared lines as context and marks changed lines", () => {
    expect(lineDiff("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual([
      { kind: "context", content: "a" },
      { kind: "deletion", content: "b" },
      { kind: "addition", content: "B" },
      { kind: "context", content: "c" },
      { kind: "addition", content: "d" },
    ]);
  });

  it("shows every line of a very large edit as a full replacement", () => {
    const before = Array.from({ length: 600 }, (_, index) => `old ${index}`).join("\n");
    const after = Array.from({ length: 600 }, (_, index) => `new ${index}`).join("\n");
    const lines = lineDiff(before, after);
    expect(lines).toHaveLength(1200);
    expect(lines.filter((line) => line.kind === "addition")).toHaveLength(600);
  });

  it("parses Codex patches and structured operation diffs", () => {
    const files = parseCodexPatch([
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@ function a",
      " keep",
      "-old",
      "+new",
      "*** Add File: src/b.ts",
      "+created",
      "*** End Patch",
      "",
    ].join("\n"));
    expect(files).toEqual([
      { action: "Update", path: "src/a.ts", lines: [
        { kind: "context", content: "keep" },
        { kind: "deletion", content: "old" },
        { kind: "addition", content: "new" },
      ] },
      { action: "Add", path: "src/b.ts", lines: [{ kind: "addition", content: "created" }] },
    ]);
    expect(operationDiffLines("-a\n+b\n")).toEqual([
      { kind: "deletion", content: "a" },
      { kind: "addition", content: "b" },
    ]);
    expect(additionLines("x\ny")).toHaveLength(2);
  });
});
