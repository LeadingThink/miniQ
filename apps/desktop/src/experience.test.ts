import { describe, expect, it } from "vitest";
import {
  createTimelineItems,
  filterTimelineGroups,
  groupTimeline,
  payloadPage,
  payloadText,
  toolCounts,
} from "./timelineModel";
import { exportFilename, exportMarkdown } from "./sessionExport";
import { markdownOutline } from "./markdownOutline";
import { filterModelIds } from "./modelSelection";
import type { Message, ToolCall } from "./types";

const message: Message = {
  id: "m",
  sessionId: "s",
  role: "assistant",
  content: "final answer",
  createdAt: "2026-09-06T01:00:02Z",
  attachments: [
    {
      path: "/tmp/evidence.md",
      name: "evidence.md",
      mimeType: "text/markdown",
    },
  ],
};
function tool(
  id: string,
  at: number,
  status: ToolCall["status"] = "succeeded"
): ToolCall {
  return {
    id,
    sessionId: "s",
    toolName: "custom_tool",
    createdAt: `2026-09-06T01:00:0${at}Z`,
    input: { command: "npm test" },
    output: "complete evidence",
    status,
  };
}

describe("long task evidence", () => {
  it("preserves sub-millisecond tool ordering before and after an answer", () => {
    const answer = { ...message, createdAt: "2026-09-06T01:00:02.123456Z" };
    const before = {
      ...tool("before", 2),
      createdAt: "2026-09-06T01:00:02.123455Z",
    };
    const after = {
      ...tool("after", 2),
      createdAt: "2026-09-06T01:00:02.123457Z",
    };
    const items = createTimelineItems([answer], [after, before]);
    expect(
      items.map((item) =>
        item.kind === "message" ? item.message.id : item.call.id
      )
    ).toEqual(["before", "m", "after"]);
    expect(groupTimeline(items).map((group) => group.kind)).toEqual([
      "tools",
      "message",
      "tools",
    ]);
  });
  it("compares timezone-equivalent fractions with different precision", () => {
    const answer = { ...message, createdAt: "2026-09-06T09:00:02.1234+08:00" };
    const before = {
      ...tool("before", 2),
      createdAt: "2026-09-06T01:00:02.12339Z",
    };
    const equal = {
      ...tool("equal", 2),
      createdAt: "2026-09-06T01:00:02.123400Z",
    };
    const items = createTimelineItems([answer], [equal, before]);
    expect(
      items.map((item) =>
        item.kind === "message" ? item.message.id : item.call.id
      )
    ).toEqual(["before", "m", "equal"]);
  });
  it("groups only contiguous tools and retains chronological message boundaries", () => {
    const calls = [
      tool("3", 3),
      tool("0", 0),
      tool("1", 1),
      tool("4", 4, "failed"),
    ];
    const groups = groupTimeline(createTimelineItems([message], calls));
    expect(groups.map((group) => group.kind)).toEqual([
      "tools",
      "message",
      "tools",
    ]);
    expect(filterTimelineGroups(groups, "activity", "")).toHaveLength(2);
    expect(filterTimelineGroups(groups, "answers", "answer")).toHaveLength(1);
    expect(filterTimelineGroups(groups, "errors", "")).toHaveLength(1);
    expect(filterTimelineGroups(groups, "all", "NPM TEST")).toHaveLength(2);
    expect(
      filterTimelineGroups(groups, "all", "complete evidence")
    ).toHaveLength(2);
    expect(filterTimelineGroups(groups, "all", "missing")).toEqual([]);
  });
  it("counts attention states without presenting failures as success", () => {
    expect(
      toolCounts([
        tool("1", 1),
        tool("2", 2, "running"),
        tool("3", 3, "waiting_approval"),
        tool("4", 4, "failed"),
      ])
    ).toEqual({ completed: 1, running: 2, failed: 1, attention: true });
  });
  it.each([false, 0, "", null])("keeps non-truthy payload %s", (value) => {
    expect(payloadText(value)).toBe(
      typeof value === "string" ? value : JSON.stringify(value)
    );
  });
  it("pages every line and search retains original source line numbers", () => {
    const lines = Array.from({ length: 231 }, (_, index) => `line ${index}`);
    const pages = [0, 1, 2].flatMap((page) =>
      payloadPage(lines.join("\n"), "", page).lines.map((line) => line.text)
    );
    expect(pages).toEqual(lines);
    expect(payloadPage(lines.join("\n"), "line 230", 99).lines).toEqual([
      { text: "line 230", number: 231 },
    ]);
  });
  it("exports complete internal records, attachments, and embedded fences", () => {
    const call = {
      ...tool("1", 1),
      toolName: "task_update",
      output: "```\n````\nfull result",
    };
    const result = exportMarkdown({
      title: "test",
      messages: [message],
      toolCalls: [call],
      plan: [],
      artifacts: [],
    });
    expect(result).toContain("task_update · succeeded");
    expect(result).toContain("/tmp/evidence.md");
    expect(result).toContain("`````json\n```\n````\nfull result\n`````");
  });
  it("avoids illegal and reserved filenames without losing the title in content", () => {
    expect(exportFilename("a:b/c? ")).toBe("a_b_c_");
    for (const name of ["CON", "LPT1.txt", "x".repeat(300), "..."])
      expect(exportFilename(name)).toBe("miniq-session");
  });
});

describe("model and markdown navigation", () => {
  it("maps heading source lines correctly after math normalization", () => {
    const outline = markdownOutline(
      "\\[x^2\\]\r\n# Actual source line\r\n$$y$$\r\n## Next"
    );
    expect(outline.map((heading) => heading.line)).toEqual([2, 4]);
  });
  it("matches model IDs case-insensitively without renaming them", () => {
    expect(filterModelIds(["GPT-Custom", "claude-custom"], "gpt")).toEqual([
      "GPT-Custom",
    ]);
  });
  it("uses collision-safe anchors and ignores fenced headings", () => {
    const outline = markdownOutline(
      "# Hello\n## Hello\n# Hello-1\n```md\n# hidden\n```\n# **Last**"
    );
    expect(outline.map((item) => item.id)).toEqual([
      "hello",
      "hello-1",
      "hello-1-1",
      "last",
    ]);
    expect(outline.map((item) => item.line)).toEqual([1, 2, 3, 7]);
  });
});
