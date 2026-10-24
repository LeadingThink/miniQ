// @vitest-environment jsdom
import { useRef } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useComposerPopoverPosition } from "./useComposerPopoverPosition";

function Fixture() {
  const inputRef = useRef<HTMLInputElement>(null);
  const position = useComposerPopoverPosition(inputRef);
  return (
    <div data-testid="scroller">
      <div className="composer-card">
        <input ref={inputRef} />
      </div>
      <div data-testid="popup" style={position} />
    </div>
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("ignores popup scroll and batches scrolls that move the input", () => {
  const measure = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue({
      top: 500,
      bottom: 650,
      left: 100,
      right: 700,
      width: 600,
      height: 150,
      x: 100,
      y: 500,
      toJSON: () => ({}),
    });
  const schedule = vi.fn();
  vi.stubGlobal("requestAnimationFrame", schedule);
  render(<Fixture />);
  measure.mockClear();
  fireEvent.scroll(screen.getByTestId("popup"));
  expect(measure).not.toHaveBeenCalled();
  expect(schedule).not.toHaveBeenCalled();
  fireEvent.scroll(screen.getByTestId("scroller"));
  fireEvent.scroll(screen.getByTestId("scroller"));
  expect(schedule).toHaveBeenCalledOnce();
  act(() => schedule.mock.calls[0][0]());
  expect(measure).toHaveBeenCalledOnce();
});
