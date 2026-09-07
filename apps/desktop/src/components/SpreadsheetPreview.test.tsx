// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SpreadsheetPreview } from "./SpreadsheetPreview";
vi.mock("read-excel-file/browser", () => ({
  default: vi.fn(async () => [
    {
      sheet: "First",
      data: [[10, "ten"], [2, "two"], ...Array.from({ length: 220 }, (_, i) => [i + 100, `entry ${i}`])],
    },
    { sheet: "Second", data: [[false, "second sheet"]] },
  ]),
}));
afterEach(cleanup);

it("filters beyond the first page, inspects cells and resets per sheet", async () => {
  render(<SpreadsheetPreview dataBase64="" onError={() => {}} />);
  await screen.findByRole("tab", { name: "First" });
  fireEvent.change(screen.getByRole("searchbox", { name: "搜索整个工作表" }), {
    target: { value: "entry 219" },
  });
  expect(screen.getByText("entry 219")).toBeTruthy();
  expect(screen.getByText("222")).toBeTruthy();
  fireEvent.click(screen.getByText("entry 219"));
  expect(screen.getByLabelText("单元格完整值").textContent).toBe("entry 219");
  fireEvent.click(screen.getByRole("tab", { name: "Second" }));
  await waitFor(() => expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe(""));
  expect(screen.getByText("false")).toBeTruthy();
  expect(screen.queryByLabelText("单元格完整值")).toBeNull();
});

it("moves keyboard focus across a pagination boundary", async () => {
  render(<SpreadsheetPreview dataBase64="" onError={() => {}} />);
  const boundary = await screen.findByText("entry 197");
  fireEvent.keyDown(boundary, { key: "ArrowDown" });
  await waitFor(() => expect(document.activeElement?.textContent).toBe("entry 198"));
  expect(screen.getByText("第 2 / 2 页 · 共 222 行")).toBeTruthy();
});
