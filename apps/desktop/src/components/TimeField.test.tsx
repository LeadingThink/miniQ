// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TimeField } from "./TimeField";

afterEach(cleanup);

it("edits hours and minutes through in-window listboxes and keeps HH:mm", () => {
  const onChange = vi.fn();
  render(<TimeField label="执行时间" value="09:05" onChange={onChange} />);
  expect(document.querySelector("input[type=time]")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "执行时间小时" }));
  const hours = screen.getByRole("listbox", { name: "执行时间小时" });
  expect(hours.parentElement).toBe(document.body);
  expect(within(hours).getAllByRole("option")).toHaveLength(24);
  fireEvent.click(within(hours).getByRole("option", { name: "23" }));
  expect(onChange).toHaveBeenLastCalledWith("23:05");

  fireEvent.click(screen.getByRole("button", { name: "执行时间分钟" }));
  const minutes = screen.getByRole("listbox", { name: "执行时间分钟" });
  expect(within(minutes).getAllByRole("option")).toHaveLength(60);
  fireEvent.click(within(minutes).getByRole("option", { name: "59" }));
  expect(onChange).toHaveBeenLastCalledWith("09:59");
});
