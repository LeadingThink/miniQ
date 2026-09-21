// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TimelineToolbar } from "./TimelineToolbar";

afterEach(cleanup);

it("keeps mobile filtering and complete queries on the same callbacks as desktop", () => {
  const onFilter = vi.fn(), onQuery = vi.fn();
  render(<TimelineToolbar filter="all" query="" exporting={false} onFilter={onFilter} onQuery={onQuery} onExport={vi.fn()} />);
  fireEvent.change(screen.getByRole("combobox", { name: "筛选会话记录" }), { target: { value: "errors" } });
  expect(onFilter).toHaveBeenCalledWith("errors");
  fireEvent.click(screen.getByRole("button", { name: "回答" }));
  expect(onFilter).toHaveBeenLastCalledWith("answers");
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "完整的长查询，不截断任何内容" } });
  expect(onQuery).toHaveBeenCalledWith("完整的长查询，不截断任何内容");
});

it("closes the more menu after actions and outside taps; Escape restores focus", async () => {
  const share = vi.fn(), onExport = vi.fn();
  render(<TimelineToolbar filter="all" query="" exporting={false} onFilter={vi.fn()} onQuery={vi.fn()} onShare={share} onExport={onExport} />);
  const trigger = screen.getByLabelText("更多会话操作");
  const menu = trigger.parentElement as HTMLDetailsElement;
  await act(async () => { fireEvent.click(trigger); });
  fireEvent.click(screen.getByRole("button", { name: "分享会话" }));
  expect(share).toHaveBeenCalledOnce();
  expect(menu.open).toBe(false);
  await act(async () => { fireEvent.click(trigger); });
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(menu.open).toBe(false);
  expect(document.activeElement).toBe(trigger);
  await act(async () => { fireEvent.click(trigger); });
  fireEvent.pointerDown(document.body);
  expect(menu.open).toBe(false);
  await act(async () => { fireEvent.click(trigger); });
  fireEvent.click(screen.getByRole("button", { name: "导出 Markdown" }));
  expect(onExport).toHaveBeenCalledWith("md");
});
