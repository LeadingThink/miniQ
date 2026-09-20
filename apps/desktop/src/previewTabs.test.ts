import { expect, it } from "vitest";
import {
  EMPTY_PREVIEW_TABS,
  closePreviewTabs,
  previewTabDirectories,
  removePreviewTab,
  reopenPreviewTab,
  selectPreviewTab,
} from "./previewTabs";
const target = (path: string) => ({ path, line: null, column: null });
it("deduplicates by full path and closes to the adjacent tab", () => {
  let state = selectPreviewTab(EMPTY_PREVIEW_TABS, target("/a/report.md"));
  state = selectPreviewTab(state, target("/b/report.md"));
  state = selectPreviewTab(state, { ...target("/b/report.md"), line: 5 });
  expect(state.targets).toHaveLength(2);
  expect(state.targets[1].line).toBe(5);
  state = removePreviewTab(state, "/b/report.md");
  expect(state.active).toBe("/a/report.md");
  expect(removePreviewTab(state, "/a/report.md")).toMatchObject({ targets: [], active: null, open: false });
});

it("reopens closed tabs with their original locations and target line", () => {
  let state = ["/a", "/b", "/c"].reduce((current, path) => selectPreviewTab(current, target(path)), EMPTY_PREVIEW_TABS);
  state = selectPreviewTab(state, { ...target("/b"), line: 12, column: 4 });
  state = removePreviewTab(state, "/b");
  expect(state.active).toBe("/c");
  state = reopenPreviewTab(state);
  expect(state.targets.map((item) => item.path)).toEqual(["/a", "/b", "/c"]);
  expect(state.targets[1]).toEqual({ path: "/b", line: 12, column: 4 });
  expect(state.active).toBe("/b");
  expect(state.closed).toEqual([]);
});

it("can undo close all, starting with the visible file, without duplicate history", () => {
  let state = ["/a", "/b", "/c"].reduce((current, path) => selectPreviewTab(current, target(path)), EMPTY_PREVIEW_TABS);
  state = selectPreviewTab(state, target("/b"));
  state = closePreviewTabs(state, new Set(state.targets.map((item) => item.path)));
  expect(state.targets).toEqual([]);
  state = reopenPreviewTab(state);
  expect(state.active).toBe("/b");
  state = selectPreviewTab(state, target("/a"));
  expect(state.closed.map((item) => item.target.path)).toEqual(["/c"]);
  state = removePreviewTab(state, "/a");
  state = reopenPreviewTab(state);
  state = removePreviewTab(state, "/a");
  expect(state.closed.map((item) => item.target.path)).toEqual(["/c", "/a"]);
});

it("keeps canonical file paths in their original tab positions", () => {
  let state = ["/a", "./report.md", "/b"].reduce((current, path) => selectPreviewTab(current, target(path)), EMPTY_PREVIEW_TABS);
  state = selectPreviewTab(state, target("/work/report.md"), "./report.md");
  expect(state.targets.map((item) => item.path)).toEqual(["/a", "/work/report.md", "/b"]);
  state = selectPreviewTab(state, target("./report.md"));
  state = selectPreviewTab(state, target("/work/report.md"), "./report.md");
  expect(state.targets.map((item) => item.path)).toEqual(["/a", "/work/report.md", "/b"]);
});

it.each(["/a", "/b", "/c"])("restores exact tab order after closing all with %s active", (active) => {
  let state = ["/a", "/b", "/c"].reduce((current, path) => selectPreviewTab(current, target(path)), EMPTY_PREVIEW_TABS);
  state = selectPreviewTab(state, target(active));
  state = closePreviewTabs(state, new Set(state.targets.map((item) => item.path)));
  state = reopenPreviewTab(state);
  expect(state.active).toBe(active);
  state = reopenPreviewTab(reopenPreviewTab(state));
  expect(state.targets.map((item) => item.path)).toEqual(["/a", "/b", "/c"]);
});

it("uses shortest unique parent suffixes for matching names across project roots", () => {
  const paths = [
    "/work/one/src/report.md",
    "/work/two/src/report.md",
    "/work/one/notes.txt",
    "C:\\docs\\report.md",
    "/report.md",
  ];
  const labels = previewTabDirectories(paths.map(target));
  expect([...labels]).toEqual(
    expect.arrayContaining([
      [paths[0], "one/src"],
      [paths[1], "two/src"],
      [paths[3], "docs"],
      [paths[4], "/"],
    ]),
  );
  expect(labels.has(paths[2])).toBe(false);
  expect(previewTabDirectories([target(paths[0])]).size).toBe(0);
});
