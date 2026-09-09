import { expect, it } from "vitest";
import {
  EMPTY_PREVIEW_TABS,
  previewTabDirectories,
  removePreviewTab,
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
  expect(removePreviewTab(state, "/a/report.md")).toEqual(EMPTY_PREVIEW_TABS);
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
