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
    expect(scroll.mock.instances.at(-1)).toBe(screen.getAllByRole("tab")[1].parentElement);
    fireEvent.click(
      screen.getByRole("button", { name: "关闭文件 /b/report.md" }),
    );
    const active = screen.getByRole("tab", { name: "notes.txt" });
    expect(document.activeElement).toBe(active);
    expect(scroll.mock.instances.at(-1)).toBe(active.parentElement);
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

it("finds tabs beyond the visible strip by full path and supports keyboard selection", () => {
  const targets = Array.from({ length: 80 }, (_, index) => ({ path: `/work/project-${index}/report.md`, line: null, column: null }));
  const select = vi.fn();
  render(<PreviewTabs id="search-tabs" tabs={targets} active={targets[0].path} onSelect={select} onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "文件标签管理，80 个已打开" }));
  const input = screen.getByRole("textbox", { name: "搜索打开的文件" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "PROJECT-79/REPORT" } });
  expect(screen.getByRole("dialog").textContent).toContain(targets[79].path);
  expect(screen.queryByRole("button", { name: "report.md /work/project-78/report.md" })).toBeNull();
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(document.activeElement?.getAttribute("title")).toBe(targets[79].path);
  fireEvent.click(document.activeElement!);
  expect(select).toHaveBeenCalledWith(targets[79]);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("offers tab management, escapes to its trigger and does not trap outside clicks", () => {
  const onCloseOthers = vi.fn(), onCloseAll = vi.fn(), onReopenClosed = vi.fn();
  const tabs = ["/one.md", "/two.md"].map((path) => ({ path, line: null, column: null }));
  render(<><button>外部内容</button><PreviewTabs id="manage-tabs" tabs={tabs} active={tabs[1].path} onSelect={() => {}} onClose={() => {}}
    onCloseOthers={onCloseOthers} onCloseAll={onCloseAll} onReopenClosed={onReopenClosed} canReopenClosed /></>);
  const trigger = screen.getByRole("button", { name: "文件标签管理，2 个已打开" });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "关闭其他文件" }));
  expect(onCloseOthers).toHaveBeenCalledWith("/two.md");
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "关闭全部文件" }));
  expect(onCloseAll).toHaveBeenCalledOnce();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "重新打开已关闭文件" }));
  expect(onReopenClosed).toHaveBeenCalledOnce();
  fireEvent.click(trigger);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "missing" } });
  expect(screen.getByText("没有匹配的文件")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  expect(document.activeElement).toBe(trigger);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger);
  fireEvent.pointerDown(screen.getByRole("button", { name: "外部内容" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps reopening discoverable with no open files and supports middle-click close", () => {
  const onClose = vi.fn(), onReopenClosed = vi.fn();
  const view = render(<PreviewTabs id="empty-tabs" tabs={[]} active="" onSelect={() => {}} onClose={onClose}
    onReopenClosed={onReopenClosed} canReopenClosed />);
  fireEvent.click(screen.getByRole("button", { name: "文件标签管理，0 个已打开" }));
  fireEvent.click(screen.getByRole("button", { name: "重新打开已关闭文件" }));
  expect(onReopenClosed).toHaveBeenCalledOnce();
  view.rerender(<PreviewTabs id="empty-tabs" tabs={[{ path: "/one.md", line: null, column: null }]}
    active="/one.md" onSelect={() => {}} onClose={onClose} />);
  fireEvent(screen.getByRole("tab"), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
  expect(onClose).toHaveBeenCalledWith("/one.md");
});
