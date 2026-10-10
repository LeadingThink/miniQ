// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createRef, useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Message } from "../types";
import { createTimelineItems, groupTimeline } from "../timelineModel";
import { TimelineEntries, type TimelineWindowHandle } from "./TimelineEntries";

const TURN_HEIGHT = 200;
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

function flushFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
  });
}

beforeEach(() => {
  frames.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => frames.delete(frame));
  vi.spyOn(Element.prototype, "clientHeight", "get").mockReturnValue(600);
  // Every turn (mounted or placeholder) is 200px tall, stacked from the top.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const element = this as HTMLElement;
    const root = element.closest<HTMLElement>(".timeline");
    let top = 0;
    let height = 600;
    if (element.dataset.turnKey) {
      const index = Array.from(element.parentElement!.children).indexOf(element);
      top = index * TURN_HEIGHT - (root?.scrollTop ?? 0);
      height = TURN_HEIGHT;
    }
    return new DOMRect(0, top, 800, height);
  });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const messages: Message[] = Array.from({ length: 80 }, (_, index) => ({
  id: `m${index}`,
  sessionId: "s",
  role: index % 2 ? "assistant" : "user",
  content: `消息 ${index}`,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
}));
const items = groupTimeline(createTimelineItems(messages, []));
const noop = () => undefined;

function Harness({ windowHandle, expandGroups = false }: {
  windowHandle?: React.RefObject<TimelineWindowHandle | null>;
  expandGroups?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div className="timeline" ref={scrollRef}>
      <TimelineEntries
        items={items}
        messages={messages}
        expandGroups={expandGroups}
        onError={noop}
        approvals={[]}
        questions={[]}
        streamingText=""
        busy={false}
        onResolveApproval={noop}
        onResolveQuestion={noop}
        onRollback={noop}
        onOpenFile={noop}
        onOpenUrl={noop}
        onRewrite={async () => true}
        scrollRef={scrollRef}
        windowHandle={windowHandle}
      />
    </div>
  );
}

const mountedTurns = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>("[data-turn-key]"))
  .flatMap((turn, index) => turn.dataset.windowPlaceholder === undefined ? [index] : []);

it("mounts only turns near the viewport plus the newest two, keeping placeholders findable", () => {
  const { container } = render(<Harness />);
  // Before the first measurement every turn stays mounted.
  expect(mountedTurns(container)).toHaveLength(40);
  flushFrames();
  expect(mountedTurns(container)).toEqual([0, 1, 2, 3, 4, 5, 38, 39]);
  const placeholder = container.querySelectorAll<HTMLElement>("[data-turn-key]")[20];
  expect(placeholder.style.height).toBe("200px");
  const stub = placeholder.querySelector<HTMLElement>("[data-user-message-id]")!;
  expect(stub.dataset.userMessageId).toBe("m40");
  expect(stub.dataset.historyAnchor).toBe("message:m40");
  expect(stub.dataset.searchRecords).toBe("message:m40 message:m41");
  expect(container.textContent).not.toContain("消息 40");

  const root = container.querySelector<HTMLElement>(".timeline")!;
  root.scrollTop = 4_000;
  fireEvent.scroll(root);
  flushFrames();
  expect(mountedTurns(container)).toEqual([17, 18, 19, 20, 21, 22, 23, 24, 25, 38, 39]);
  expect(container.textContent).toContain("消息 40");
});

it("mounts a windowed-out record's turn on request and renders search results in full", () => {
  const windowHandle = createRef<TimelineWindowHandle>();
  const { container, rerender } = render(<Harness windowHandle={windowHandle} />);
  flushFrames();
  let mounted = false;
  act(() => { mounted = windowHandle.current!.mountRecord("message:m61"); });
  expect(mounted).toBe(true);
  expect(mountedTurns(container)).toContain(30);
  expect(container.textContent).toContain("消息 61");
  expect(windowHandle.current!.mountRecord("message:m61")).toBe(false);
  expect(windowHandle.current!.mountRecord("message:missing")).toBe(false);
  // A reader's scroll releases it again.
  fireEvent.scroll(container.querySelector(".timeline")!);
  flushFrames();
  expect(mountedTurns(container)).not.toContain(30);

  rerender(<Harness windowHandle={windowHandle} expandGroups />);
  expect(mountedTurns(container)).toHaveLength(40);
});
