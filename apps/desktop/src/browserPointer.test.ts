// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBrowserAutomationScript, parseBrowserScriptResult } from "./browserAutomationScript";

const roots = new Map<Element, ShadowRoot>();
const selector = "[data-miniq-browser-pointer]";

function execute(operation: string, args: Record<string, unknown> = {}, owner = document) {
  const script = buildBrowserAutomationScript(operation, { nextObservationId: crypto.randomUUID(), ...args }, "tab-pointer");
  return parseBrowserScriptResult(JSON.stringify(new Function("document", "return " + script)(owner)));
}

function act(operation: string, args: Record<string, unknown>) {
  const expectedObservation = execute("snapshot");
  return execute(operation, { ...args, expectedObservation });
}

function indicator(owner = document) {
  const host = owner.querySelector(selector)!;
  return roots.get(host)!.querySelector("div")!;
}

function populate(owner = document) {
  owner.body.innerHTML = '<button data-testid="save">保存</button><input aria-label="姓名">';
  owner.querySelectorAll("button,input").forEach((node, index) => {
    node.getBoundingClientRect = () => ({
      x: 40 + index * 120, y: 60, left: 40 + index * 120, top: 60,
      width: 80, height: 30, right: 120 + index * 120, bottom: 90,
    }) as DOMRect;
  });
}

beforeEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.useFakeTimers();
  roots.clear();
  const attach = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (this: Element, options) {
    const root = attach.call(this, options);
    roots.set(this, root);
    return root;
  });
  populate();
});

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  Reflect.deleteProperty(document, "elementFromPoint");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("browser-owned automation pointer", () => {
  it("renders the black outlined cursor with a blue glow and leaves the system cursor styles alone", () => {
    document.body.style.cursor = "crosshair";
    const button = document.querySelector("button")!;
    button.style.cursor = "help";
    const click = vi.fn();
    button.addEventListener("click", click);
    act("click", { locator: { by: "testId", value: "save" } });
    const host = document.querySelector<HTMLElement>(selector)!;
    expect(host.shadowRoot).toBeNull();
    expect(host.getAttribute("aria-hidden")).toBe("true");
    expect(host.style.pointerEvents).toBe("none");
    expect(host.style.position).toBe("fixed");
    expect(host.style.zIndex).toBe("2147483647");
    expect(indicator().style.transform).toBe("translate(77px,72px)");
    const arrow = roots.get(host)!.querySelector("path")!;
    expect(arrow.getAttribute("fill")).toBe("#111315");
    expect(arrow.getAttribute("stroke")).toBe("#fff");
    expect(arrow.getAttribute("stroke-width")).toBe("2.2");
    expect(indicator().querySelector("div")!.style.background).toContain("radial-gradient");
    expect(roots.get(host)!.textContent).toBe("");
    expect(document.body.style.cursor).toBe("crosshair");
    expect(button.style.cursor).toBe("help");
    expect(click).toHaveBeenCalledOnce();
    document.body.style.cursor = "";
  });

  it("uses the requested coordinates for both the cursor and the click event", () => {
    const button = document.querySelector("button")!;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => button) });
    const down = vi.fn();
    button.addEventListener("mousedown", down);
    act("click", { x: 45, y: 65 });
    expect(indicator().style.transform).toBe("translate(42px,62px)");
    expect(down.mock.calls[0][0]).toMatchObject({ clientX: 45, clientY: 65 });
  });

  it("ignores real mouse movements and reuses one cursor across automated actions", () => {
    act("move", { locator: { by: "testId", value: "save" } });
    const pointer = indicator();
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 600, clientY: 500, bubbles: true }));
    expect(pointer.style.transform).toBe("translate(77px,72px)");
    act("type", { locator: { by: "label", value: "姓名" }, text: "张三" });
    expect(document.querySelectorAll(selector)).toHaveLength(1);
    expect(indicator()).toBe(pointer);
    expect(pointer.style.transform).toBe("translate(197px,72px)");
    expect(document.querySelector("input")!.value).toBe("张三");
  });

  it("shows the destination of a drag and does not move after invalid or stale actions", () => {
    act("drag", {
      locator: { by: "testId", value: "save" }, endLocator: { by: "label", value: "姓名" },
    });
    const pointer = indicator();
    expect(pointer.style.transform).toBe("translate(197px,72px)");
    expect(pointer.style.transitionDuration).toBe("260ms,180ms");
    const observed = execute("snapshot");
    expect(() => execute("click", {
      locator: { by: "testId", value: "save" }, expectedObservation: { ...observed, documentId: "stale" },
    })).toThrow("stale observation");
    expect(() => act("drag", {
      locator: { by: "testId", value: "save" }, endLocator: { by: "css", value: "#missing" },
    })).toThrow("no matching element");
    expect(pointer.style.transform).toBe("translate(197px,72px)");
  });

  it("never includes the cursor in snapshots or CSS locator candidates", () => {
    const initial = execute("snapshot");
    act("move", { locator: { by: "testId", value: "save" } });
    const host = document.querySelector(selector)!;
    host.getBoundingClientRect = () => document.querySelector("button")!.getBoundingClientRect();
    const after = execute("snapshot");
    expect(after.total).toBe(initial.total);
    expect(after.textLines).toEqual(initial.textLines);
    expect(after.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ text: "miniQ" })]));
    expect(() => act("click", { locator: { by: "css", value: selector } })).toThrow("no matching element");
  });

  it("fades after idle time without snapshots extending its lifetime and cleans up on navigation", () => {
    act("move", { locator: { by: "testId", value: "save" } });
    const pointer = indicator();
    vi.advanceTimersByTime(1000);
    execute("snapshot");
    vi.advanceTimersByTime(800);
    expect(pointer.style.opacity).toBe("0");
    act("move", { locator: { by: "testId", value: "save" } });
    expect(pointer.style.opacity).toBe("1");
    window.dispatchEvent(new Event("pagehide"));
    expect(document.querySelector(selector)).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    act("move", { locator: { by: "testId", value: "save" } });
    expect(indicator()).not.toBe(pointer);
  });

  it("keeps pointer positions separate for different browser documents", () => {
    const other = document.implementation.createHTMLDocument("Other tab");
    populate(other);
    act("move", { locator: { by: "testId", value: "save" } });
    execute("move", { locator: { by: "label", value: "姓名" } }, other);
    expect(indicator().style.transform).toBe("translate(77px,72px)");
    expect(indicator(other).style.transform).toBe("translate(197px,72px)");
    document.querySelector(selector)!.remove();
    act("move", { locator: { by: "testId", value: "save" } });
    expect(document.querySelectorAll(selector)).toHaveLength(1);
    expect(indicator(other).style.transform).toBe("translate(197px,72px)");
  });

  it("does not create a pointer for observation-only or rejected operations", () => {
    execute("snapshot");
    expect(document.querySelector(selector)).toBeNull();
    document.querySelector("button")!.disabled = true;
    expect(() => act("click", { locator: { by: "testId", value: "save" } })).toThrow("disabled");
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true, value: () => document.querySelector("button"),
    });
    expect(() => act("click", { x: 50, y: 65 })).toThrow("disabled");
    expect(document.querySelector(selector)).toBeNull();
  });

  it("tracks double-click, targeted key presses and scroll without following untargeted keys", () => {
    act("doubleClick", { locator: { by: "testId", value: "save" } });
    const pointer = indicator();
    expect(pointer.style.transform).toBe("translate(77px,72px)");
    act("press", { locator: { by: "label", value: "姓名" }, key: "Enter" });
    expect(pointer.style.transform).toBe("translate(197px,72px)");
    act("press", { key: "Escape" });
    expect(pointer.style.transform).toBe("translate(197px,72px)");
    Object.defineProperty(document, "scrollingElement", { configurable: true, value: document.documentElement });
    document.documentElement.scrollBy = vi.fn();
    act("scroll", { locator: { by: "testId", value: "save" }, deltaY: 50 });
    expect(pointer.style.transform).toBe("translate(77px,72px)");
    expect(document.documentElement.scrollBy).toHaveBeenCalledWith({ left: 0, top: 50, behavior: "instant" });
    Reflect.deleteProperty(document, "scrollingElement");
  });

  it("positions the cursor at a native choice's visible bounds", () => {
    const bounds = document.querySelector("button")!.getBoundingClientRect();
    document.body.innerHTML = '<div><label><input type="radio">同意</label></div>';
    document.querySelector("div")!.getBoundingClientRect = () => bounds;
    const observed = act("click", { locator: { by: "role", value: "radio", name: "同意" } });
    expect(indicator().style.transform).toBe("translate(77px,72px)");
    expect(observed.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "radio", bounds: { x: 40, y: 60, width: 80, height: 30 } }),
    ]));
  });

  it("indicates valid select actions and does not move after a rejected selection", () => {
    const bounds = document.querySelector("input")!.getBoundingClientRect();
    const select = document.createElement("select");
    select.setAttribute("aria-label", "阶段");
    select.innerHTML = '<option value="a">早期</option><option value="b">成长期</option>';
    select.getBoundingClientRect = () => bounds;
    document.body.append(select);
    act("move", { locator: { by: "testId", value: "save" } });
    expect(() => act("select", { locator: { by: "label", value: "阶段" }, values: ["missing"] }))
      .toThrow("no matching option");
    expect(indicator().style.transform).toBe("translate(77px,72px)");
    act("select", { locator: { by: "label", value: "阶段" }, values: ["b"] });
    expect(select.value).toBe("b");
    expect(indicator().style.transform).toBe("translate(197px,72px)");
  });
});
