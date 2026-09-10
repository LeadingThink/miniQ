// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkbenchPanel } from "./WorkbenchPanel";
import { WORKBENCH_WIDTH_STORAGE_KEY as key } from "../workbenchWidth";

let viewport = 1400;
let sidebar = 264;
let measure: () => void;
let flush: FrameRequestCallback | null;
let captures: Set<number>;
let writes: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  viewport = 1400;
  sidebar = 264;
  flush = null;
  captures = new Set();
  localStorage.clear();
  vi.spyOn(window, "innerWidth", "get").mockImplementation(() => viewport);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => viewport,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ width: sidebar }) as DOMRect,
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        measure = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    flush = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    flush = null;
  });
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId: number;
      constructor(type: string, options: PointerEventInit) {
        super(type, options);
        this.pointerId = options.pointerId ?? 1;
      }
    },
  );
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: (id: number) => captures.add(id),
    hasPointerCapture: (id: number) => captures.has(id),
    releasePointerCapture: (id: number) => captures.delete(id),
  });
  writes = vi.spyOn(Storage.prototype, "setItem");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as Partial<HTMLElement>).setPointerCapture;
  delete (HTMLElement.prototype as Partial<HTMLElement>).hasPointerCapture;
  delete (HTMLElement.prototype as Partial<HTMLElement>).releasePointerCapture;
});

function mount(child = <aside className="file-preview-panel">Document</aside>) {
  return render(
    <div className="app">
      <div className="sidebar" />
      <main />
      <WorkbenchPanel>{child}</WorkbenchPanel>
    </div>,
  );
}
const handle = () => screen.getByRole("separator");
const width = () => Number(handle().getAttribute("aria-valuenow"));
function tick() {
  act(() => {
    const callback = flush;
    flush = null;
    callback?.(0);
  });
}
function start() {
  fireEvent.pointerDown(handle(), { button: 0, pointerId: 1, clientX: 800 });
}
function move(x: number, pointerId = 1) {
  fireEvent.pointerMove(window, { pointerId, clientX: x });
}
function finish(x: number) {
  fireEvent.pointerUp(window, { pointerId: 1, clientX: x });
}

it("coalesces outside-handle moves, commits final release coordinates once, and preserves children", () => {
  const child = vi.fn(() => <iframe title="interactive preview" />);
  const Child = child;
  mount(<Child />);
  const frame = screen.getByTitle("interactive preview");
  start();
  expect(document.activeElement).toBe(handle());
  move(780);
  move(760);
  expect(width()).toBe(560);
  tick();
  expect(width()).toBe(600);
  expect(writes).not.toHaveBeenCalled();
  move(750);
  finish(740);
  expect(width()).toBe(620);
  expect(writes).toHaveBeenCalledExactlyOnceWith(key, "620");
  expect(screen.getByTitle("interactive preview")).toBe(frame);
  expect(child).toHaveBeenCalledTimes(1);
  expect(document.body.classList.contains("workbench-resizing")).toBe(false);
  expect(captures.size).toBe(0);
  expect(flush).toBeNull();
});

it("preserves fractional pointer motion without accumulating rounding drift", () => {
  mount();
  start();
  for (let i = 1; i <= 10; i++) move(800 - i * 0.4);
  tick();
  expect(width()).toBe(564);
  finish(796);
  expect(width()).toBe(564);
});

it("does not overwrite a wider preference when the handle is only clicked", () => {
  localStorage.setItem(key, "900");
  writes.mockClear();
  mount();
  start();
  finish(800);
  expect(writes).not.toHaveBeenCalled();
  act(() => {
    viewport = 1800;
    measure();
  });
  expect(width()).toBe(900);
});

it("cancels an active drag when entering full-screen mobile layout", () => {
  mount();
  start();
  move(700);
  tick();
  expect(width()).toBe(660);
  act(() => {
    viewport = 390;
    measure();
  });
  expect(document.body.classList.contains("workbench-resizing")).toBe(false);
  act(() => {
    viewport = 1400;
    measure();
  });
  expect(width()).toBe(560);
  expect(writes).not.toHaveBeenCalled();
});

it("immediately reverses after reaching either width bound", () => {
  mount();
  start();
  move(0);
  tick();
  expect(width()).toBe(786);
  move(20);
  tick();
  expect(width()).toBe(766);
  move(1500);
  tick();
  expect(width()).toBe(320);
  move(1490);
  tick();
  expect(width()).toBe(330);
  finish(1490);
});

it("ignores secondary buttons and unrelated pointers", () => {
  mount();
  fireEvent.pointerDown(handle(), { button: 2, pointerId: 1, clientX: 800 });
  expect(captures.size).toBe(0);
  start();
  move(700, 2);
  tick();
  expect(width()).toBe(560);
  fireEvent.pointerUp(window, { pointerId: 2, clientX: 700 });
  expect(writes).not.toHaveBeenCalled();
  finish(780);
  expect(width()).toBe(580);
});

it.each(["Escape", "pointercancel", "lostpointercapture", "blur"])(
  "restores preferred width and cleans up on %s",
  (reason) => {
    mount();
    start();
    move(700);
    tick();
    expect(width()).toBe(660);
    if (reason === "Escape") fireEvent.keyDown(handle(), { key: "Escape" });
    else if (reason === "blur") fireEvent.blur(window);
    else
      fireEvent(
        reason === "lostpointercapture" ? handle() : window,
        new PointerEvent(reason, { pointerId: 1 }),
      );
    expect(width()).toBe(560);
    expect(writes).not.toHaveBeenCalled();
    expect(captures.size).toBe(0);
    expect(document.body.classList.contains("workbench-resizing")).toBe(false);
    move(600);
    tick();
    expect(width()).toBe(560);
  },
);

it("removes drag listeners and a pending frame when the panel closes", () => {
  const view = mount();
  start();
  move(700);
  view.unmount();
  finish(690);
  tick();
  expect(writes).not.toHaveBeenCalled();
  expect(captures.size).toBe(0);
  expect(document.body.classList.contains("workbench-resizing")).toBe(false);
});

it("restores width after window and sidebar changes without rewriting the preference", () => {
  localStorage.setItem(key, "750");
  writes.mockClear();
  mount();
  expect(width()).toBe(750);
  act(() => {
    viewport = 1000;
    measure();
  });
  expect(width()).toBe(386);
  start();
  move(790);
  tick();
  fireEvent.keyDown(handle(), { key: "Escape" });
  act(() => {
    viewport = 1400;
    measure();
  });
  expect(width()).toBe(750);
  act(() => {
    viewport = 1000;
    sidebar = 0;
    measure();
  });
  expect(width()).toBe(650);
  act(() => {
    viewport = 1400;
    measure();
  });
  expect(width()).toBe(750);
  expect(writes).not.toHaveBeenCalled();
});

it("keeps the handle usable in narrow desktop overlays and hides it only on mobile", () => {
  viewport = 800;
  const view = mount();
  expect(
    view.container
      .querySelector(".workbench-panel")
      ?.getAttribute("data-layout"),
  ).toBe("overlay");
  start();
  finish(700);
  expect(width()).toBe(660);
  act(() => {
    viewport = 390;
    measure();
  });
  expect(screen.queryByRole("separator")).toBeNull();
  expect(
    view.container
      .querySelector(".workbench-panel")
      ?.getAttribute("data-layout"),
  ).toBe("mobile");
  act(() => {
    viewport = 800;
    measure();
  });
  expect(width()).toBe(660);
});

it("supports keyboard adjustment, bounds, reset, and persistence across reopen", () => {
  const view = mount();
  fireEvent.keyDown(handle(), { key: "ArrowLeft" });
  expect(width()).toBe(572);
  fireEvent.keyDown(handle(), { key: "ArrowRight", shiftKey: true });
  expect(width()).toBe(524);
  fireEvent.keyDown(handle(), { key: "Home" });
  expect(width()).toBe(320);
  fireEvent.keyDown(handle(), { key: "End" });
  expect(width()).toBe(786);
  fireEvent.keyDown(handle(), { key: "Enter" });
  expect(width()).toBe(560);
  start();
  finish(700);
  expect(width()).toBe(660);
  view.unmount();
  mount();
  expect(width()).toBe(660);
  fireEvent.doubleClick(handle());
  expect(width()).toBe(560);
  expect(localStorage.getItem(key)).toBe("560");
});
