// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { showUndoToast, TOAST_DURATION, ToastProvider, useToast } from "./Toast";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function DeletableList(props: { onCommit: (id: string) => void }) {
  const toast = useToast();
  const [hidden, setHidden] = useState<string[]>([]);
  return (
    <ul>
      {["a", "b"].filter((id) => !hidden.includes(id)).map((id) => (
        <li key={id}>
          {id}
          <button
            onClick={() => {
              setHidden((current) => [...current, id]);
              showUndoToast(toast, {
                message: `已删除 ${id}`,
                onCommit: () => props.onCommit(id),
                onUndo: () => setHidden((current) => current.filter((item) => item !== id)),
              });
            }}
          >
            删除 {id}
          </button>
        </li>
      ))}
    </ul>
  );
}

function setup() {
  const onCommit = vi.fn();
  render(<ToastProvider><DeletableList onCommit={onCommit} /></ToastProvider>);
  return onCommit;
}

it("hides optimistically and restores on 撤销 without committing", () => {
  const onCommit = setup();
  fireEvent.click(screen.getByRole("button", { name: "删除 a" }));
  expect(screen.queryByRole("button", { name: "删除 a" })).toBeNull();
  expect(screen.getByText("已删除 a")).toBeTruthy();
  expect(screen.getByRole("region", { name: "通知" }).getAttribute("aria-live")).toBe("polite");
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  expect(screen.getByRole("button", { name: "删除 a" })).toBeTruthy();
  expect(screen.queryByText("已删除 a")).toBeNull();
  act(() => void vi.advanceTimersByTime(TOAST_DURATION * 2));
  expect(onCommit).not.toHaveBeenCalled();
});

it("commits after the timeout", () => {
  const onCommit = setup();
  fireEvent.click(screen.getByRole("button", { name: "删除 b" }));
  act(() => void vi.advanceTimersByTime(TOAST_DURATION - 1));
  expect(onCommit).not.toHaveBeenCalled();
  act(() => void vi.advanceTimersByTime(1));
  expect(onCommit).toHaveBeenCalledExactlyOnceWith("b");
  expect(screen.queryByText("已删除 b")).toBeNull();
});

it("pauses the timer while hovered and commits when dismissed", () => {
  const onCommit = setup();
  fireEvent.click(screen.getByRole("button", { name: "删除 a" }));
  const toast = screen.getByText("已删除 a").closest(".ui-toast") as HTMLElement;
  fireEvent.mouseEnter(toast);
  act(() => void vi.advanceTimersByTime(TOAST_DURATION * 3));
  expect(onCommit).not.toHaveBeenCalled();
  fireEvent.mouseLeave(toast);
  fireEvent.click(screen.getByRole("button", { name: "关闭通知" }));
  expect(onCommit).toHaveBeenCalledExactlyOnceWith("a");
  act(() => void vi.advanceTimersByTime(TOAST_DURATION * 2));
  expect(onCommit).toHaveBeenCalledOnce();
});

it("commits immediately when no provider is mounted", () => {
  const onCommit = vi.fn();
  render(<DeletableList onCommit={onCommit} />);
  fireEvent.click(screen.getByRole("button", { name: "删除 a" }));
  expect(onCommit).toHaveBeenCalledWith("a");
});
