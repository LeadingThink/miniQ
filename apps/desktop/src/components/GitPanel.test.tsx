// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { GitPanel } from "./GitPanel";

afterEach(cleanup);

const STATUS = {
  root: "/project",
  branch: "main...origin/main",
  entries: [{ path: "src/app.ts", indexStatus: "M", worktreeStatus: "M", additions: 1, deletions: 0 }],
  stats: { additions: 1, deletions: 0 },
};

it("loads status, expands the first file, and collapses it on click", async () => {
  const call = vi.fn((method: string) =>
    Promise.resolve(method === "git.status" ? STATUS : { diff: "worktree change" }),
  );
  render(<GitPanel client={{ call } as unknown as RpcClient} sessionId="session-1" />);

  expect(await screen.findByText("worktree change")).toBeTruthy();
  expect(screen.getByText("main")).toBeTruthy();
  expect(screen.getByText("origin/main")).toBeTruthy();
  expect(screen.getAllByText("+1")).toHaveLength(2);
  expect(call).toHaveBeenCalledWith("git.diff", {
    sessionId: "session-1",
    path: "src/app.ts",
    staged: false,
  });

  fireEvent.click(screen.getByRole("button", { name: /app\.ts/ }));
  await waitFor(() => expect(screen.queryByText("worktree change")).toBeNull());
});

it("compares against a branch picked from the searchable menu", async () => {
  const call = vi.fn((method: string, input?: { base?: string }) => {
    if (method === "git.branches")
      return Promise.resolve({
        current: "main",
        branches: [
          { name: "main", remote: false, current: true },
          { name: "origin/dev", remote: true, current: false },
        ],
      });
    if (method === "git.status")
      return Promise.resolve(input?.base ? { ...STATUS, base: input.base, entries: [], stats: { additions: 0, deletions: 0 } } : STATUS);
    return Promise.resolve({ diff: "" });
  });
  render(<GitPanel client={{ call } as unknown as RpcClient} sessionId="session-1" />);

  await screen.findByText("origin/main");
  fireEvent.click(screen.getByRole("button", { name: /origin\/main/ }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "origin/dev" }));

  await waitFor(() =>
    expect(call).toHaveBeenCalledWith(
      "git.status",
      { sessionId: "session-1", base: "origin/dev" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  );
  expect(await screen.findByText("与 origin/dev 没有差异。")).toBeTruthy();
  expect(screen.getByRole("button", { name: "分支" })).toBeTruthy();
});

it("renders a unified diff line by line with syntax highlighting", async () => {
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1234567..89abcde 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,2 +1,3 @@",
    "-const port = 8000;",
    "+const port = 8001;",
    "+const debug = true;",
    " export const app = createApp(port);",
    "",
  ].join("\n");
  const call = vi.fn((method: string) =>
    Promise.resolve(method === "git.status" ? STATUS : { diff }),
  );
  const view = render(
    <GitPanel client={{ call } as unknown as RpcClient} sessionId="session-1" />,
  );

  await waitFor(() => expect(view.container.querySelectorAll(".diff-line")).toHaveLength(4));
  expect(view.container.querySelector(".diff-line.deletion .diff-line-number")?.textContent).toBe("1");
  expect(view.container.querySelectorAll(".diff-line.addition")).toHaveLength(2);
  expect(view.container.querySelector(".diff-hunk-header")?.textContent).toBe("@@ -1,2 +1,3 @@");
  await waitFor(() =>
    expect(view.container.querySelector(".diff-line.addition .hljs-keyword")?.textContent).toBe("const"),
  );
  expect(view.container.querySelector(".git-diff-file")?.textContent).toBe("src/app.ts");
});

it("shows the filename above the diff and folds unchanged lines away from edits", async () => {
  const context = Array.from({ length: 8 }, (_, index) => ` line ${index}`);
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,17 +1,17 @@",
    ...context,
    "-const removed = true;",
    "+const added = true;",
    ...context,
    "",
  ].join("\n");
  const call = vi.fn((method: string) =>
    Promise.resolve(method === "git.status" ? STATUS : { diff }),
  );
  const view = render(
    <GitPanel client={{ call } as unknown as RpcClient} sessionId="session-1" />,
  );

  await waitFor(() => expect(view.container.querySelector(".git-diff-file")?.textContent).toBe("src/app.ts"));
  expect(view.container.querySelectorAll(".diff-line.context")).toHaveLength(6);
  fireEvent.click(screen.getAllByRole("button", { name: /展开/ })[0]);
  expect(view.container.querySelectorAll(".diff-line.context").length).toBeGreaterThan(6);
});

it("colors a raw diff when the payload has no structured hunks", async () => {
  const diff = [
    "warning: in the working copy of notes.txt, LF will be replaced by CRLF",
    "-old line",
    "+new line",
    "",
  ].join("\n");
  const call = vi.fn((method: string) =>
    Promise.resolve(method === "git.status"
      ? { ...STATUS, entries: [{ path: "notes.txt", indexStatus: "M", worktreeStatus: " ", additions: 1, deletions: 1 }] }
      : { diff }),
  );
  const view = render(
    <GitPanel client={{ call } as unknown as RpcClient} sessionId="session-1" />,
  );

  await waitFor(() => expect(view.container.querySelector(".git-raw-line.addition")?.textContent).toBe("+new line"));
  expect(view.container.querySelector(".git-raw-line.deletion")?.textContent).toBe("-old line");
  expect(view.container.querySelector(".git-raw-line.meta")?.textContent).toContain("warning:");
});
