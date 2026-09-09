// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PreviewTabs } from "./PreviewTabs";
import {
  EMPTY_PREVIEW_TABS,
  removePreviewTab,
  selectPreviewTab,
} from "../previewTabs";
afterEach(cleanup);

it("preserves full-path identities and keyboard focus when switching and closing", () => {
  function Fixture() {
    const [state, setState] = useState(() =>
      selectPreviewTab(
        selectPreviewTab(EMPTY_PREVIEW_TABS, {
          path: "/a/report.md",
          line: null,
          column: null,
        }),
        {
          path: "/b/report.md",
          line: null,
          column: null,
        },
      ),
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

it("shows same-name directories and keeps the active tab visible and focused after mouse close", () => {
  const scroll = vi.fn();
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "scrollIntoView",
  );
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scroll,
  });
  try {
    const targets = ["/a/report.md", "/b/report.md", "/notes.txt"].map(
      (path) => ({ path, line: null, column: null }),
    );
    function Fixture() {
      const [tabs, setTabs] = useState(targets);
      const [active, setActive] = useState(targets[1].path);
      return (
        <PreviewTabs
          id="mouse-tabs"
          tabs={tabs}
          active={active}
          onSelect={(target) => setActive(target.path)}
          onClose={(path) => {
            setTabs((current) =>
              current.filter((target) => target.path !== path),
            );
            setActive(targets[2].path);
          }}
        />
      );
    }
    render(<Fixture />);
    expect(screen.getByText("a")).toBeTruthy();
    expect(screen.getByText("b")).toBeTruthy();
    expect(scroll.mock.instances.at(-1)).toBe(screen.getAllByRole("tab")[1]);
    fireEvent.click(
      screen.getByRole("button", { name: "关闭文件 /b/report.md" }),
    );
    const active = screen.getByRole("tab", { name: "notes.txt" });
    expect(document.activeElement).toBe(active);
    expect(scroll.mock.instances.at(-1)).toBe(active);
    expect(screen.queryByText("a")).toBeNull();
  } finally {
    if (descriptor)
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollIntoView",
        descriptor,
      );
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});
