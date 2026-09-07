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
