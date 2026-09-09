// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DocumentControls } from "./DocumentControls";
afterEach(cleanup);

it("edits multi-digit page numbers without rendering intermediate pages", () => {
  const onPage = vi.fn();
  const props = {
    label: "PDF",
    page: 1,
    count: 125,
    onPage,
    scale: 1,
    fit: true,
    onScale: vi.fn(),
    onFit: vi.fn(),
  };
  const view = render(<DocumentControls {...props} />);
  const input = screen.getByLabelText("PDF 页码");
  for (const value of ["", "1", "12"])
    fireEvent.change(input, { target: { value } });
  expect(onPage).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onPage).toHaveBeenCalledWith(12);
  view.rerender(<DocumentControls {...props} page={12} />);
  fireEvent.change(input, { target: { value: "999" } });
  fireEvent.blur(input);
  expect(onPage).toHaveBeenLastCalledWith(125);
  fireEvent.change(input, { target: { value: "25" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect((input as HTMLInputElement).value).toBe("12");
});
