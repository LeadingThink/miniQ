// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PdfSearch } from "./PdfSearch";
import type { PdfTextPage } from "../pdfSearch";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("searches all pages and navigates matching pages in both directions", async () => {
  vi.useFakeTimers();
  const onPage = vi.fn();
  const document = {
    numPages: 4,
    getPage: async (page: number) => ({
      getTextContent: async () => ({
        items: [{ str: page % 2 === 0 ? "needle needle" : "other" }],
      }),
    }),
  };
  render(<PdfSearch document={document} onPage={onPage} />);
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "needle" },
  });
  await act(() => vi.advanceTimersByTimeAsync(250));
  expect(screen.getByRole("status").textContent).toContain("2 页 · 4 处");
  fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Enter" });
  expect(onPage).toHaveBeenLastCalledWith(2);
  fireEvent.keyDown(screen.getByRole("searchbox"), {
    key: "Enter",
    shiftKey: true,
  });
  expect(onPage).toHaveBeenLastCalledWith(4);
  fireEvent.click(screen.getByRole("button", { name: "清空 PDF 搜索" }));
  expect(screen.queryByRole("status")).toBeNull();
});

it("cancels old document results after switching files", async () => {
  vi.useFakeTimers();
  let finish!: (page: PdfTextPage) => void;
  const document = {
    numPages: 1,
    getPage: () =>
      new Promise<PdfTextPage>((resolve) => {
        finish = resolve;
      }),
  };
  const { rerender } = render(<PdfSearch document={document} onPage={() => {}} />);
  fireEvent.change(screen.getByRole("searchbox"), {
    target: { value: "needle" },
  });
  await act(() => vi.advanceTimersByTimeAsync(250));
  rerender(<PdfSearch document={{ numPages: 0, getPage: document.getPage }} onPage={() => {}} />);
  await act(() => vi.advanceTimersByTimeAsync(250));
  await act(async () => {
    finish({ getTextContent: async () => ({ items: [{ str: "needle" }] }) });
  });
  expect(screen.getByRole("status").textContent).toBe("无匹配文本");
});
