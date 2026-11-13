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

it("uses the non-modal browser top layer without opening a modal dialog", () => {
  const showPopover = vi.fn(function (this: HTMLElement) { this.style.display = "block"; });
  const hidePopover = vi.fn(function (this: HTMLElement) { this.style.display = "none"; });
  Object.defineProperties(HTMLElement.prototype, {
    showPopover: { configurable: true, value: showPopover },
    hidePopover: { configurable: true, value: hidePopover },
  });
  function Harness() {
    const anchor = useRef<HTMLButtonElement>(null);
    return <>
      <button ref={anchor}>上下文用量</button>
      <Popover open anchorRef={anchor} onClose={() => {}} label="上下文用量" layer="non-modal">
        <button>关闭</button>
      </Popover>
    </>;
  }

  const view = render(<Harness />);
  const popover = screen.getByRole("dialog", { name: "上下文用量" });
  expect(popover.tagName).toBe("DIV");
  expect(popover.getAttribute("popover")).toBe("manual");
  expect(showPopover).toHaveBeenCalledOnce();

  view.unmount();
  expect(hidePopover).toHaveBeenCalledOnce();
});
