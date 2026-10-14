// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Popover } from "./Popover";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("waits for visible positioning before moving focus into the dropdown", () => {
  const visibility: string[] = [];
  const original = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options,
  ) {
    const panel = this.closest<HTMLElement>(".ui-popover");
    if (panel) visibility.push(panel.style.visibility);
    original.call(this, options);
  });
  function Harness() {
    const anchor = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={anchor}>选择电脑</button>
        <Popover open anchorRef={anchor} onClose={() => {}} label="电脑">
          <button>电脑 A</button>
        </Popover>
      </>
    );
  }
  render(<Harness />);
  expect(visibility.length).toBeGreaterThan(0);
  expect(visibility).not.toContain("hidden");
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "电脑 A" }),
  );
});
