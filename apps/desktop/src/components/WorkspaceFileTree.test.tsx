// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  ancestorDirectories,
  breadcrumb,
  fileKind,
  sortEntries,
  splitFileName,
  visibleRows,
  type TreeDirectory,
} from "../fileTreeModel";
import type { RemoteDirectory } from "../remoteFiles";
import { WorkspaceFileTree } from "./WorkspaceFileTree";

afterEach(cleanup);

const entry = (path: string, directory = false) => ({
  name: path.split("/").at(-1)!,
  path,
  directory,
  size: 1,
});
const dir = (path: string, entries: RemoteDirectory["entries"], nextCursor: string | null = null): RemoteDirectory => ({
  path,
  parent: null,
  roots: ["/p"],
  entries,
  nextCursor,
});

it("sorts folders first with natural name order and classifies files", () => {
  const sorted = sortEntries([
    entry("/p/b10.py"),
    entry("/p/zeta", true),
    entry("/p/b2.py"),
    entry("/p/Alpha", true),
  ]).map((item) => item.name);
  expect(sorted).toEqual(["Alpha", "zeta", "b2.py", "b10.py"]);
  expect(fileKind("报表.XLSX")).toBe("sheet");
  expect(fileKind("run.py")).toBe("code");
  expect(fileKind("README")).toBe("text");
  expect(splitFileName("download_mindshow_themes.py")).toEqual({
    stem: "download_mindshow_themes",
    tail: ".py",
  });
  expect(splitFileName("a.py")).toEqual({ stem: "a.py", tail: "" });
});

it("computes ancestors, breadcrumbs and filtered rows", () => {
  expect(ancestorDirectories("/p", "/p/a/b/c.md")).toEqual(["/p/a", "/p/a/b"]);
  expect(ancestorDirectories("/p", "/other/c.md")).toEqual([]);
  expect(breadcrumb("/w/proj/docs/a.md", ["/w", "/w/proj/"])).toBe("proj › docs › a.md");
  expect(breadcrumb("/elsewhere/a.md", ["/w"])).toBe("/elsewhere/a.md");
  const dirs = new Map<string, TreeDirectory>([
    ["/p", { entries: [entry("/p/src", true), entry("/p/notes.md")], nextCursor: null, loading: false, error: null }],
    ["/p/src", { entries: [entry("/p/src/main.rs"), entry("/p/src/lib.rs")], nextCursor: null, loading: false, error: null }],
  ]);
  expect(visibleRows("/p", dirs, new Set(), "").map((row) => row.entry.name)).toEqual(["src", "notes.md"]);
  expect(visibleRows("/p", dirs, new Set(["/p/src"]), "").map((row) => `${row.depth}:${row.entry.name}`)).toEqual(["0:src", "1:lib.rs", "1:main.rs", "0:notes.md"]);
  // Filtering opens folders containing loaded matches even when collapsed.
  expect(visibleRows("/p", dirs, new Set(), "MAIN").map((row) => row.entry.name)).toEqual(["src", "main.rs"]);
});

it("lazily expands folders, reveals the active file, opens files and filters", async () => {
  const call = vi.fn(async (_method: string, params: { path: string; after?: string }) => {
    if (params.path === "") return dir("/p", [entry("/p/notes.md"), entry("/p/src", true)]);
    if (params.path === "/p/src") return dir("/p/src", [entry("/p/src/main.rs")]);
    throw new Error("unexpected");
  });
  const onOpen = vi.fn();
  const client = { call, mode: "local" } as never;
  const view = render(
    <WorkspaceFileTree access={{ client, sessionId: "s1" }} onOpen={onOpen} activePath={null} />,
  );
  const src = await screen.findByRole("treeitem", { name: /src/ });
  expect(screen.getAllByRole("treeitem").map((item) => item.textContent)).toEqual(["src", "notes.md"]);
  expect(src.getAttribute("aria-expanded")).toBe("false");
  await act(async () => {
    fireEvent.click(src);
  });
  expect(call).toHaveBeenLastCalledWith("file.list", { sessionId: "s1", path: "/p/src", after: undefined });
  const main = await screen.findByRole("treeitem", { name: /main\.rs/ });
  fireEvent.click(main);
  expect(onOpen).toHaveBeenCalledWith("/p/src/main.rs");

  view.rerender(
    <WorkspaceFileTree access={{ client, sessionId: "s1" }} onOpen={onOpen} activePath="/p/src/main.rs" />,
  );
  expect(screen.getByRole("treeitem", { name: /main\.rs/ }).getAttribute("aria-selected")).toBe("true");

  // Collapse with ArrowLeft on the folder, then filter to re-open it.
  fireEvent.keyDown(screen.getByRole("treeitem", { name: /^src$/ }), { key: "ArrowLeft" });
  expect(screen.queryByRole("treeitem", { name: /main\.rs/ })).toBeNull();
  const filter = screen.getByRole("searchbox", { name: "筛选文件" });
  fireEvent.change(filter, { target: { value: "main" } });
  expect(screen.getAllByRole("treeitem").map((item) => item.textContent)).toEqual(["src", "main.rs"]);
  fireEvent.keyDown(filter, { key: "Enter" });
  expect(onOpen).toHaveBeenLastCalledWith("/p/src/main.rs");
  fireEvent.keyDown(filter, { key: "Escape" });
  expect((filter as HTMLInputElement).value).toBe("");
});

it("pages large folders", async () => {
  const call = vi.fn(async (_method: string, params: { path: string; after?: string }) => {
    if (params.path === "") return dir("/p", [entry("/p/a.md")], "a.md");
    if (params.after === "a.md") return dir("/p", [entry("/p/b.md")]);
    throw new Error("unexpected");
  });
  render(<WorkspaceFileTree access={{ client: { call, mode: "local" } as never, sessionId: "s1" }} onOpen={vi.fn()} />);
  const more = await screen.findByRole("button", { name: "加载更多" });
  await act(async () => {
    fireEvent.click(more);
  });
  expect(screen.getAllByRole("treeitem").map((item) => item.textContent)).toEqual(["a.md", "b.md"]);
  expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
});

it("filters into unopened folders and skips heavy build folders", async () => {
  const call = vi.fn(async (_method: string, params: { path: string; after?: string }) => {
    if (params.path === "") {
      return dir("/p", [entry("/p/docs", true), entry("/p/node_modules", true), entry("/p/readme.md")]);
    }
    if (params.path === "/p/docs") return dir("/p/docs", [entry("/p/docs/api", true)]);
    if (params.path === "/p/docs/api") return dir("/p/docs/api", [entry("/p/docs/api/guide.md")]);
    throw new Error(`unexpected ${params.path}`);
  });
  const onOpen = vi.fn();
  render(<WorkspaceFileTree access={{ client: { call, mode: "local" } as never, sessionId: "s1" }} onOpen={onOpen} />);
  await screen.findByRole("treeitem", { name: /docs/ });
  const filter = screen.getByRole("searchbox", { name: "筛选文件" });
  await act(async () => {
    fireEvent.change(filter, { target: { value: "guide" } });
  });
  await screen.findByRole("treeitem", { name: /guide\.md/ });
  expect(screen.getAllByRole("treeitem").map((item) => item.textContent)).toEqual(["docs", "api", "guide.md"]);
  expect(call.mock.calls.map(([, params]) => params.path)).not.toContain("/p/node_modules");
  fireEvent.keyDown(filter, { key: "Enter" });
  expect(onOpen).toHaveBeenCalledWith("/p/docs/api/guide.md");
});
