// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useFilePreview } from "./useFilePreview";
import { readLocalFilePreview, type LocalFilePreview } from "../localFiles";
vi.mock("../localFiles", () => ({ readLocalFilePreview: vi.fn() }));
afterEach(cleanup);

it("restores session tab identities and re-reads contents", async () => {
  vi.mocked(readLocalFilePreview).mockImplementation(async (path) => ({
    path,
    kind: "markdown",
    mimeType: "text/markdown",
    size: 1,
    content: path,
    dataBase64: null,
  }));
  const hook = renderHook(({ id }) => useFilePreview("/workspace", id), {
    initialProps: { id: "a" },
  });
  const first = { path: "/workspace/first.md", line: null, column: null };
  const second = { ...first, path: "/workspace/second.md" };
  await act(async () => {
    await hook.result.current.openFile(first);
  });
  await act(async () => {
    await hook.result.current.openFile(second);
  });
  expect(hook.result.current.tabs).toHaveLength(2);
  hook.rerender({ id: "b" });
  expect(hook.result.current.tabs).toEqual([]);
  expect(hook.result.current.state.content).toBeNull();
  await act(async () => hook.rerender({ id: "a" }));
  expect(hook.result.current.tabs).toHaveLength(2);
  expect(hook.result.current.state.content).toBe(second.path);
  await act(async () => hook.result.current.closeTab(second.path));
  expect(hook.result.current.state.content).toBe(first.path);
});

it("clears previews between sessions in the same workspace and ignores a late file read", async () => {
  let resolve!: (value: LocalFilePreview) => void;
  vi.mocked(readLocalFilePreview).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const hook = renderHook(({ id }) => useFilePreview("/workspace", id), {
    initialProps: { id: "a" },
  });
  let pending!: Promise<void>;
  act(() => {
    pending = hook.result.current.openFile({
      path: "/workspace/a.md",
      line: null,
      column: null,
    });
  });
  expect(hook.result.current.state.open).toBe(true);
  hook.rerender({ id: "b" });
  expect(hook.result.current.state.open).toBe(false);
  await act(async () => {
    resolve({
      path: "/workspace/a.md",
      kind: "markdown",
      mimeType: "text/markdown",
      size: 6,
      dataBase64: null,
      content: "A only",
    });
    await pending;
  });
  expect(hook.result.current.state.content).toBeNull();
});

it("releases the payload on close while preserving tab identities for reopening", async () => {
  vi.mocked(readLocalFilePreview).mockResolvedValue({
    path: "/workspace/movie.mp4",
    kind: "video",
    mimeType: "video/mp4",
    size: 100,
    content: null,
    dataBase64: "large-payload",
  });
  const hook = renderHook(() => useFilePreview("/workspace", "a"));
  await act(async () =>
    hook.result.current.openFile({
      path: "/workspace/movie.mp4",
      line: null,
      column: null,
    }),
  );
  expect(hook.result.current.state.dataBase64).toBe("large-payload");
  act(() => hook.result.current.close());
  expect(hook.result.current.state.dataBase64).toBeNull();
  expect(hook.result.current.state.open).toBe(false);
  expect(hook.result.current.tabs).toHaveLength(1);
  await act(async () => hook.result.current.reopen());
  expect(hook.result.current.state.open).toBe(true);
  expect(hook.result.current.state.dataBase64).toBe("large-payload");
});

it("restores closed files and view state only in their original session", async () => {
  vi.mocked(readLocalFilePreview).mockImplementation(async (path) => ({
    path, kind: "text", mimeType: "text/plain", size: 3, content: path, dataBase64: null,
  }));
  const hook = renderHook(({ id }) => useFilePreview("/workspace", id), { initialProps: { id: "a" } });
  const targets = ["first", "second", "third"].map((name) => ({ path: `/workspace/${name}.txt`, line: null, column: null }));
  for (const target of targets) await act(async () => hook.result.current.openFile(target));
  const view = hook.result.current.views.forFile(hook.result.current.viewScope, targets[1].path);
  view.set("page", 8);
  await act(async () => hook.result.current.closeOtherTabs(targets[1].path));
  expect(hook.result.current.tabs).toEqual([targets[1]]);
  expect(hook.result.current.state.target).toEqual(targets[1]);
  act(() => hook.result.current.closeAllTabs());
  expect(hook.result.current.state.content).toBeNull();
  expect(hook.result.current.canReopenClosedTab).toBe(true);
  hook.rerender({ id: "b" });
  expect(hook.result.current.canReopenClosedTab).toBe(false);
  act(() => hook.result.current.reopenClosedTab());
  expect(hook.result.current.state.open).toBe(false);
  hook.rerender({ id: "a" });
  await act(async () => hook.result.current.reopenClosedTab());
  expect(hook.result.current.state.target).toEqual(targets[1]);
  expect(hook.result.current.views.forFile(hook.result.current.viewScope, targets[1].path).get("page")).toBe(8);
});

it("keeps batched closes coherent and cancels a late payload when closing all tabs", async () => {
  let resolve!: (value: LocalFilePreview) => void;
  vi.mocked(readLocalFilePreview).mockImplementation(() => new Promise((done) => { resolve = done; }));
  const hook = renderHook(() => useFilePreview("/workspace", "a"));
  let pending!: Promise<void>;
  act(() => {
    pending = hook.result.current.openFile({ path: "/workspace/late.md", line: null, column: null });
    hook.result.current.closeAllTabs();
  });
  await act(async () => {
    resolve({ path: "/workspace/late.md", kind: "markdown", mimeType: "text/markdown", size: 3, content: "late", dataBase64: null });
    await pending;
  });
  expect(hook.result.current.tabs).toEqual([]);
  expect(hook.result.current.state.open).toBe(false);
  expect(hook.result.current.state.content).toBeNull();
  expect(hook.result.current.canReopenClosedTab).toBe(true);
});
