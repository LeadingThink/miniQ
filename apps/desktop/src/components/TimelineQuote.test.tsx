// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { COMPOSER_INSERT_EVENT } from "../composerMention";
import { TimelineQuote, quotableSelection } from "./TimelineQuote";

beforeEach(() => {
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 10, left: 20, bottom: 30, right: 60, width: 40, height: 20, x: 20, y: 10 }) as DOMRect;
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
});
afterEach(() => {
  window.getSelection()?.removeAllRanges();
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function Harness() {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <>
      <div className="timeline" ref={ref} data-testid="root">
        <div className="bubble user"><p data-testid="user">用户的问题</p></div>
        <div className="bubble assistant"><p data-testid="answer">助手的回答</p></div>
        <div className="bubble assistant"><div className="tool-transcript"><p data-testid="tool">工具输出</p></div></div>
      </div>
      <TimelineQuote scrollRef={ref} />
    </>
  );
}

function select(node: Node, start = 0, end = (node.textContent ?? "").length, endNode: Node = node) {
  const range = document.createRange();
  range.setStart(node.firstChild ?? node, start);
  range.setEnd(endNode.firstChild ?? endNode, end);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
}

it("accepts selections inside one bubble only", () => {
  render(<Harness />);
  const root = screen.getByTestId("root");
  select(screen.getByTestId("answer"), 0, 2);
  expect(quotableSelection(root)?.text).toBe("助手");
  select(screen.getByTestId("user"), 0, 2, screen.getByTestId("answer"));
  expect(quotableSelection(root)).toBeNull();
  select(screen.getByTestId("tool"));
  expect(quotableSelection(root)).toBeNull();
  window.getSelection()!.removeAllRanges();
  expect(quotableSelection(root)).toBeNull();
});

it("shows a 引用 button that sends a markdown quote to the composer", () => {
  vi.useFakeTimers();
  render(<Harness />);
  const received: string[] = [];
  const listener = (event: Event) => received.push((event as CustomEvent<{ text: string }>).detail.text);
  window.addEventListener(COMPOSER_INSERT_EVENT, listener);
  select(screen.getByTestId("answer"));
  fireEvent.mouseUp(screen.getByTestId("answer"));
  act(() => { vi.runAllTimers(); });
  const button = screen.getByRole("button", { name: "引用" });
  expect(button.getAttribute("title")).toBe("引用到输入框");
  fireEvent.click(button);
  window.removeEventListener(COMPOSER_INSERT_EVENT, listener);
  expect(received).toEqual(["> 助手的回答\n\n"]);
  expect(screen.queryByRole("button", { name: "引用" })).toBeNull();
});
