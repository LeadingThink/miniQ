// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RemoteDevicePicker } from "./RemoteDevicePicker";

afterEach(cleanup);

it("never selects the only online computer automatically and retains an offline selection", () => {
  const onSelect = vi.fn();
  const a = { id: "a", name: "电脑 A", online: false };
  const b = { id: "b", name: "电脑 B", online: true };
  const view = render(<RemoteDevicePicker devices={[b]} selected={a} loading={false} onSelect={onSelect} onRefresh={vi.fn()} />);
  expect(screen.getByRole("button", { name: /电脑 A/ }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: /电脑 A/ }).textContent).toContain("离线");
  view.rerender(<RemoteDevicePicker devices={[{ ...a, online: true }, b]} selected={a} loading={false} onSelect={onSelect} onRefresh={vi.fn()} />);
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /电脑 B/ }));
  expect(onSelect).toHaveBeenCalledWith(b);
});

it("requires explicit choice on first use even with one computer", () => {
  const onSelect = vi.fn();
  render(<RemoteDevicePicker devices={[{ id: "a", name: "A", online: true }]} selected={null} loading={false} onSelect={onSelect} onRefresh={vi.fn()} />);
  expect(onSelect).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: /A/ }).getAttribute("aria-pressed")).toBe("false");
});
