// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PreviewSelection } from "./PreviewSelection";

beforeEach(() => {
  vi.stubGlobal("visualViewport", Object.assign(new EventTarget(), {
    width: 800,
    height: 600,
    offsetLeft: 0,
    offsetTop: 0,
  }));
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(800);
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(140);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(140);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("opens only a compact reference button above the selection", () => {
  const send = vi.fn();
  const clear = vi.fn();
  const view = render(
    <div data-testid="preview-layout">
      <PreviewSelection
        visible
        anchor={{ x: 420, y: 260 }}
        onDiscuss={send}
        onClear={clear}
      />
    </div>,
  );

  const button = screen.getByRole("button", { name: "引用" });
  expect(view.getByTestId("preview-layout").contains(button)).toBe(false);
  expect(button.style.left).toBe("420px");
  expect(button.style.top).toBe("112px");
  expect(screen.queryByText("完整选区")).toBeNull();
  fireEvent.click(button);
  expect(send).toHaveBeenCalledOnce();
  fireEvent.blur(button);
  expect(clear).toHaveBeenCalledOnce();
});

it("does not render without a selection anchor", () => {
  render(
    <PreviewSelection
      visible
      anchor={null}
      onDiscuss={vi.fn()}
      onClear={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: "引用" })).toBeNull();
});
