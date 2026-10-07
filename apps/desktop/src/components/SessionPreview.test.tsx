// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionPreview } from "./SessionPreview";

const props = { title: "会话标题", detail: "更新于今天", contextLabel: "项目上下文", preview: "会话预览" };
function view(disabled = false) {
  return <SessionPreview {...props} disabled={disabled}><button aria-describedby="context">会话</button></SessionPreview>;
}
function advance(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}
function hover(element = screen.getByRole("button"), pointerType = "mouse") {
  fireEvent.pointerEnter(element, { pointerType });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("waits 400ms and renders the complete preview in a body portal", () => {
  const { container } = render(view());
  hover();
  advance(399);
  expect(screen.queryByRole("tooltip")).toBeNull();
  advance(1);
  const tooltip = screen.getByRole("tooltip");
  expect(tooltip.parentElement).toBe(document.body);
  expect(container.contains(tooltip)).toBe(false);
  expect(tooltip.querySelector("strong")?.textContent).toBe(props.title);
  expect(Array.from(tooltip.querySelectorAll("small"), (node) => node.textContent)).toEqual([props.detail, props.contextLabel]);
  expect(tooltip.querySelector("p")?.textContent).toBe(props.preview);
});

it("cancels pending entry and allows hovering across the gap into the preview", () => {
  render(view());
  hover();
  advance(200);
  fireEvent.pointerLeave(screen.getByRole("button"), { pointerType: "mouse" });
  advance(400);
  expect(screen.queryByRole("tooltip")).toBeNull();
  hover();
  advance(400);
  fireEvent.pointerLeave(screen.getByRole("button"), { pointerType: "mouse" });
  advance(99);
  hover(screen.getByRole("tooltip"));
  advance(400);
  expect(screen.queryByRole("tooltip")).not.toBeNull();
  fireEvent.pointerLeave(screen.getByRole("tooltip"), { pointerType: "mouse" });
  advance(99);
  expect(screen.queryByRole("tooltip")).not.toBeNull();
  advance(1);
  expect(screen.queryByRole("tooltip")).toBeNull();
});

it.each(["touch", "pen"])("does not open for %s hover", (pointerType) => {
  render(view());
  hover(undefined, pointerType);
  advance(1000);
  expect(screen.queryByRole("tooltip")).toBeNull();
});

it("opens on keyboard focus, merges descriptions, and closes on blur", () => {
  render(view());
  const button = screen.getByRole("button");
  act(() => button.focus());
  const tooltip = screen.getByRole("tooltip");
  expect(button.getAttribute("aria-describedby")).toBe(`context ${tooltip.id}`);
  act(() => button.blur());
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(button.getAttribute("aria-describedby")).toBe("context");
});

it.each(["Escape", "scroll", "resize", "click"])("closes immediately on %s and cancels pending entry", (action) => {
  render(view());
  const dismiss = () => {
    if (action === "Escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (action === "click") fireEvent.click(screen.getByRole("button"));
    else if (action === "scroll") fireEvent.scroll(screen.getByRole("button"));
    else fireEvent.resize(window);
  };
  hover();
  dismiss();
  advance(400);
  expect(screen.queryByRole("tooltip")).toBeNull();
  hover();
  advance(400);
  expect(screen.queryByRole("tooltip")).not.toBeNull();
  dismiss();
  expect(screen.queryByRole("tooltip")).toBeNull();
});

it("does not display when disabled and closes when disabled changes", () => {
  const { rerender } = render(view(true));
  hover();
  fireEvent.focus(screen.getByRole("button"));
  advance(400);
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(screen.getByRole("button").getAttribute("aria-describedby")).toBe("context");
  rerender(view());
  hover();
  advance(400);
  expect(screen.queryByRole("tooltip")).not.toBeNull();
  rerender(view(true));
  expect(screen.queryByRole("tooltip")).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});

it("cleans timers, portal, and window listeners on unmount", () => {
  const remove = vi.spyOn(window, "removeEventListener");
  const { unmount } = render(view());
  hover();
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  for (const name of ["keydown", "resize", "scroll"]) {
    expect(remove.mock.calls.some(([event]) => event === name)).toBe(true);
  }
  const second = render(view());
  hover();
  advance(400);
  second.unmount();
  expect(screen.queryByRole("tooltip")).toBeNull();
});

it.each([
  { viewport: 1000, left: 100, right: 200, expectedLeft: 208, width: 300 },
  { viewport: 1000, left: 800, right: 900, expectedLeft: 492, width: 300 },
  { viewport: 250, left: 20, right: 120, expectedLeft: 8, width: 234 },
])("positions within viewport $viewport with measured height", ({ viewport, left, right, expectedLeft, width }) => {
  vi.stubGlobal("innerWidth", viewport);
  vi.stubGlobal("innerHeight", 600);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return (this.className === "session-preview-anchor"
      ? { left, right, top: 550, bottom: 580, width: right - left, height: 30 }
      : { left: 0, right: width, top: 0, bottom: 120, width, height: 120 }) as DOMRect;
  });
  render(view());
  hover();
  advance(400);
  const style = screen.getByRole("tooltip").style;
  expect(style.left).toBe(`${expectedLeft}px`);
  expect(style.width).toBe(`${width}px`);
  expect(style.top).toBe("472px");
});
