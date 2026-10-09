// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TimelineToolbar } from "./TimelineToolbar";

afterEach(cleanup);

it("keeps mobile filtering and complete queries on the same callbacks as desktop", () => {
  const onFilter = vi.fn(), onQuery = vi.fn();
  render(<TimelineToolbar filter="all" query="" exporting={false} onFilter={onFilter} onQuery={onQuery} onExport={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "筛选会话记录" }));
  fireEvent.click(screen.getByRole("button", { name: /异常记录/ }));
  expect(onFilter).toHaveBeenCalledWith("errors");
  fireEvent.click(screen.getByRole("button", { name: "回答" }));
  expect(onFilter).toHaveBeenLastCalledWith("answers");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "完整的长查询，不截断任何内容" } });
  expect(onQuery).toHaveBeenCalledWith("完整的长查询，不截断任何内容");
});

it("closes the mobile filter with Escape, the close button, or the scrim", () => {
  render(<TimelineToolbar filter="all" query="" exporting={false} onFilter={vi.fn()} onQuery={vi.fn()} onExport={vi.fn()} />);
  const trigger = screen.getByRole("button", { name: "筛选会话记录" });
  fireEvent.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "筛选记录" });
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "筛选记录" })).toBeNull();

  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("button", { name: "关闭记录筛选" }));
  expect(screen.queryByRole("dialog", { name: "筛选记录" })).toBeNull();

  fireEvent.click(trigger);
  fireEvent.mouseDown(screen.getByRole("dialog", { name: "筛选记录" }).parentElement!);
  expect(screen.queryByRole("dialog", { name: "筛选记录" })).toBeNull();
});

it("closes the more menu after actions and outside taps; Escape restores focus", async () => {
  const share = vi.fn(), onExport = vi.fn();
  render(<TimelineToolbar filter="all" query="" exporting={false} onFilter={vi.fn()} onQuery={vi.fn()} onShare={share} onExport={onExport} />);
  const trigger = screen.getByLabelText("更多会话操作");

  await act(async () => { fireEvent.click(trigger); });
  fireEvent.click(screen.getByRole("menuitem", { name: "分享会话" }));
  expect(share).toHaveBeenCalledOnce();
  expect(screen.queryByRole("menu")).toBeNull();
  await act(async () => { fireEvent.click(trigger); });
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await act(async () => { fireEvent.click(trigger); });
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
  await act(async () => { fireEvent.click(trigger); });
  fireEvent.click(screen.getByRole("menuitem", { name: "导出 Markdown" }));
  expect(onExport).toHaveBeenCalledWith("md");
});

it("collapses search behind an icon until opened, and stays open while a query is active", () => {
  const { container, rerender } = render(<TimelineToolbar filter="all" query="" exporting={false} onFilter={vi.fn()} onQuery={vi.fn()} onExport={vi.fn()} />);
  const toolbar = container.querySelector(".conversation-tools")!;
  expect(toolbar.getAttribute("data-search-open")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "搜索和筛选会话" }));
  expect(toolbar.getAttribute("data-search-open")).toBe("true");
  expect(document.activeElement).toBe(screen.getByRole("searchbox"));
  fireEvent.blur(screen.getByRole("searchbox"), { relatedTarget: document.body });
  expect(toolbar.getAttribute("data-search-open")).toBe("false");
  rerender(<TimelineToolbar filter="all" query="needle" exporting={false} onFilter={vi.fn()} onQuery={vi.fn()} onExport={vi.fn()} />);
  expect(toolbar.getAttribute("data-search-open")).toBe("true");
  rerender(<TimelineToolbar filter="errors" query="" exporting={false} onFilter={vi.fn()} onQuery={vi.fn()} onExport={vi.fn()} />);
  expect(toolbar.getAttribute("data-search-open")).toBe("true");
});

it("renders all actions outside the clipped wallpaper header and dispatches each once", () => {
  const onShare = vi.fn(), onDiagnostics = vi.fn(), onExport = vi.fn();
  const { container } = render(<div style={{ overflow: "hidden", backdropFilter: "blur(6px)", transform: "translateZ(0)" }}><TimelineToolbar filter="all" query="" exporting={false} onFilter={vi.fn()} onQuery={vi.fn()} onShare={onShare} onDiagnostics={onDiagnostics} onExport={onExport} /></div>);
  for (const name of ["分享会话", "模型调用记录", "导出 Markdown", "导出 JSON"]) {
    fireEvent.click(screen.getByRole("button", { name: "更多会话操作" }));
    const popup = screen.getByRole("menu");
    expect(popup.parentElement).toBe(document.body);
    expect(container.contains(popup)).toBe(false);
    fireEvent.click(screen.getByRole("menuitem", { name }));
    expect(screen.queryByRole("menu")).toBeNull();
  }
  expect(onShare).toHaveBeenCalledOnce();
  expect(onDiagnostics).toHaveBeenCalledOnce();
  expect(onExport.mock.calls).toEqual([["md"], ["json"]]);
});
