import { expect, it } from "vitest";
import { collectWebSources, detectPullRequests } from "./sessionContext";
import type { Message, ToolCall } from "./types";

function call(id: string, toolName: string, input: unknown, output: unknown, status: ToolCall["status"] = "succeeded"): ToolCall {
  return { id, sessionId: "s", toolName, input, output, status, createdAt: "2026-10-10T00:00:00Z" };
}

function message(id: string, role: Message["role"], content: string): Message {
  return { id, sessionId: "s", role, content, createdAt: "2026-10-10T00:00:00Z" };
}

it("collects visited pages before search hits and keeps search titles", () => {
  const sources = collectWebSources([
    call("1", "web_search", { query: "rust" }, JSON.stringify({
      results: [
        { title: "Rust", url: "https://www.rust-lang.org/" },
        { title: "Docs", url: "https://doc.rust-lang.org/book/" },
        { title: "Bad", url: "javascript:alert(1)" },
      ],
    })),
    call("2", "web_fetch", { url: "https://doc.rust-lang.org/book/" }, { finalUrl: "https://doc.rust-lang.org/book/" }),
    call("3", "browser_automation", { action: "open", url: "https://example.com/a" }, { url: "https://example.com/a", title: "Example" }),
    call("4", "browser_automation", { action: "click" }, { url: "https://example.com/clicked" }),
    call("5", "web_fetch", { url: "https://failed.example/" }, undefined, "failed"),
  ]);
  expect(sources).toEqual([
    { url: "https://doc.rust-lang.org/book/", title: "Docs", domain: "doc.rust-lang.org", via: "visited" },
    { url: "https://example.com/a", title: "Example", domain: "example.com", via: "visited" },
    { url: "https://www.rust-lang.org/", title: "Rust", domain: "rust-lang.org", via: "search" },
  ]);
});

it("ignores tools that do not consult the web", () => {
  expect(collectWebSources([call("1", "file_read", { path: "https://x.dev" }, { url: "https://x.dev" })])).toEqual([]);
});

it("detects GitHub pull requests in messages and tool output once each", () => {
  const pulls = detectPullRequests(
    [
      message("u", "user", "review https://github.com/LeadingThink/miniQ/pull/42 please"),
      message("sys", "system", "https://github.com/hidden/repo/pull/1"),
      message("a", "assistant", "Opened https://github.com/leadingthink/miniq/pull/42/files and https://github.com/o/r/issues/3"),
    ],
    [call("1", "shell", { command: "gh pr create" }, "https://github.com/o/r.js/pull/7\n")],
  );
  expect(pulls).toEqual([
    { url: "https://github.com/LeadingThink/miniQ/pull/42", owner: "LeadingThink", repo: "miniQ", number: 42 },
    { url: "https://github.com/o/r.js/pull/7", owner: "o", repo: "r.js", number: 7 },
  ]);
});
