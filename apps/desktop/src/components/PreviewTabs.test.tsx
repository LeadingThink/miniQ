// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PreviewTabs } from "./PreviewTabs";
import { EMPTY_PREVIEW_TABS, removePreviewTab, selectPreviewTab } from "../previewTabs";
afterEach(cleanup);

it("preserves full-path identities and keyboard focus when switching and closing", () => {
  function Fixture() {
    const [state, setState] = useState(() =>
      selectPreviewTab(selectPreviewTab(EMPTY_PREVIEW_TABS, { path: "/a/report.md", line: null, column: null }), {
        path: "/b/report.md",
        line: null,
        column: null,
      }),
    );
    return (
      <PreviewTabs
        id="test-tabs"
        tabs={state.targets}
        active={state.active ?? ""}
        onSelect={(target) => setState(selectPreviewTab(state, target))}
        onClose={(path) => setState(removePreviewTab(state, path))}
      />
    );
  }
  render(<Fixture />);
  const tabs = screen.getAllByRole("tab");
  fireEvent.keyDown(tabs[1], { key: "ArrowLeft" });
  expect(document.activeElement).toBe(tabs[0]);
  expect(tabs[0].getAttribute("aria-selected")).toBe("true");
  fireEvent.keyDown(tabs[0], { key: "Delete" });
  expect(screen.getAllByRole("tab")).toHaveLength(1);
  expect(document.activeElement).toBe(screen.getByRole("tab"));
  expect(screen.getByRole("tab").getAttribute("title")).toBe("/b/report.md");
});
