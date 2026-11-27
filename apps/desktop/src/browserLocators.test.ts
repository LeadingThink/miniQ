// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildBrowserAutomationScript, parseBrowserScriptResult } from "./browserAutomationScript";

function execute(operation: string, args: Record<string, unknown>) {
  return parseBrowserScriptResult(JSON.stringify(eval(buildBrowserAutomationScript(operation, args, "tab-locators"))));
}
function observe() {
  return execute("snapshot", { nextObservationId: crypto.randomUUID() });
}
function act(operation: string, args: Record<string, unknown>) {
  const observed = observe();
  return execute(operation, { ...args, expectedObservation: observed, nextObservationId: crypto.randomUUID() });
}
function visible(element: Element) {
  element.getBoundingClientRect = () => ({ x: 0, y: 0, width: 80, height: 24, top: 0, left: 0, right: 80, bottom: 24 }) as DOMRect;
}
beforeEach(() => {
  document.body.innerHTML = `
    <label for="name">姓名</label><input id="name" placeholder="填写姓名">
    <button aria-label="保存表单" data-testid="save">保存</button>
    <select aria-label="阶段"><option value="a">早期</option><option value="b">成长期</option></select>`;
  document.querySelectorAll("*").forEach(visible);
});
afterEach(() => vi.restoreAllMocks());

describe("direct browser element locators", () => {
  it.each([
    { by: "role", value: "button", name: "保存表单" },
    { by: "text", value: "保存" },
    { by: "testId", value: "save" },
    { by: "css", value: "button[data-testid=save]" },
  ])("clicks by $by without coordinate lookup", (locator) => {
    const click = vi.fn();
    document.querySelector("button")!.addEventListener("click", click);
    const hitTest = vi.fn(() => { throw new Error("coordinate lookup must not run"); });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hitTest });
    act("click", { locator });
    expect(click).toHaveBeenCalledOnce();
    expect(hitTest).not.toHaveBeenCalled();
  });

  it.each([{ by: "label", value: "姓名" }, { by: "placeholder", value: "填写姓名" }])("fills by $by", (locator) => {
    const input = document.querySelector("input")!;
    const changed = vi.fn();
    input.addEventListener("input", changed);
    act("type", { locator, text: "张三" });
    expect(input.value).toBe("张三");
    expect(changed).toHaveBeenCalledOnce();
  });

  it("resolves a semantic locator against a replacement DOM node", () => {
    const observed = observe();
    const previous = document.querySelector("button")!;
    const replacement = previous.cloneNode(true) as HTMLButtonElement;
    visible(replacement);
    previous.replaceWith(replacement);
    const click = vi.fn();
    replacement.addEventListener("click", click);
    execute("click", { locator: { by: "role", value: "button", name: "保存表单" }, expectedObservation: observed, nextObservationId: "after" });
    expect(click).toHaveBeenCalledOnce();
  });

  it("rejects ambiguous and missing locators without dispatching input", () => {
    const clone = document.querySelector("button")!.cloneNode(true) as Element;
    visible(clone);
    document.body.append(clone);
    const click = vi.fn();
    document.body.addEventListener("click", click);
    expect(() => act("click", { locator: { by: "role", value: "button" } })).toThrow("ambiguous locator");
    expect(() => act("click", { locator: { by: "text", value: "不存在" } })).toThrow("no matching element");
    expect(click).not.toHaveBeenCalled();
  });

  it("excludes hidden and inert ancestors and rejects disabled inputs", () => {
    document.querySelector("button")!.setAttribute("hidden", "");
    expect(() => act("click", { locator: { by: "testId", value: "save" } })).toThrow("no matching element");
    const input = document.querySelector("input")!;
    input.disabled = true;
    expect(() => act("type", { locator: { by: "label", value: "姓名" }, text: "invalid" })).toThrow("disabled");
    expect(input.value).toBe("");
  });

  it("exposes implicit roles and aria-labelledby names in the snapshot", () => {
    const label = document.querySelector("label")!;
    label.id = "name-label";
    document.querySelector("input")!.setAttribute("aria-labelledby", label.id);
    expect(observe().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "textbox", label: "姓名" }),
      expect.objectContaining({ role: "button", label: "保存表单" }),
    ]));
  });

  it("targets keyboard events, double clicks and scrolling by element", () => {
    const input = document.querySelector("input")!;
    const key = vi.fn();
    input.addEventListener("keydown", key);
    act("press", { locator: { by: "label", value: "姓名" }, key: "Enter" });
    expect(document.activeElement).toBe(input);
    expect(key).toHaveBeenCalledOnce();
    const double = vi.fn();
    document.querySelector("button")!.addEventListener("dblclick", double);
    act("doubleClick", { locator: { by: "testId", value: "save" } });
    expect(double).toHaveBeenCalledOnce();
    input.style.overflowY = "auto";
    Object.defineProperties(input, { scrollHeight: { configurable: true, value: 200 }, clientHeight: { configurable: true, value: 20 } });
    input.scrollBy = vi.fn();
    act("scroll", { locator: { by: "label", value: "姓名" }, deltaY: 80 });
    expect(input.scrollBy).toHaveBeenCalledWith({ left: 0, top: 80, behavior: "instant" });
  });

  it("selects options using a role locator", () => {
    act("select", { locator: { by: "role", value: "combobox", name: "阶段" }, values: ["b"] });
    expect(document.querySelector("select")!.value).toBe("b");
  });

  it("uses exact matching by default and supports explicit partial text", () => {
    expect(() => act("click", { locator: { by: "label", value: "保存" } })).toThrow("no matching element");
    act("click", { locator: { by: "label", value: "保存", exact: false } });
  });

  it("finds controls in open shadow roots", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = '<button aria-label="Shadow save">Save</button>';
    visible(root.querySelector("button")!);
    const click = vi.fn();
    root.querySelector("button")!.addEventListener("click", click);
    act("click", { locator: { by: "role", value: "button", name: "Shadow save" } });
    expect(click).toHaveBeenCalledOnce();
  });

  it("still rejects a changed document before resolving a locator", () => {
    const observed = observe();
    expect(() => execute("click", { locator: { by: "testId", value: "save" }, expectedObservation: { ...observed, documentId: "other" }, nextObservationId: "next" })).toThrow("stale observation");
  });

  it("resolves both drag endpoints before dispatching any mouse events", () => {
    const source = document.querySelector("input")!;
    const destination = document.querySelector("button")!;
    const down = vi.fn();
    const up = vi.fn();
    source.addEventListener("mousedown", down);
    destination.addEventListener("mouseup", up);
    expect(() => act("drag", {
      locator: { by: "css", value: "#name" }, endLocator: { by: "css", value: "#missing" },
    })).toThrow("no matching element");
    expect(down).not.toHaveBeenCalled();
    act("drag", { locator: { by: "css", value: "#name" }, endLocator: { by: "testId", value: "save" } });
    expect(down).toHaveBeenCalledOnce();
    expect(up).toHaveBeenCalledOnce();
  });

  it("does not write read-only fields or interact with inert subtrees", () => {
    const field = document.querySelector("input")!;
    field.readOnly = true;
    expect(() => act("type", { locator: { by: "css", value: "#name" }, text: "invalid" })).toThrow("read-only");
    field.parentElement!.setAttribute("inert", "");
    expect(() => act("click", { locator: { by: "testId", value: "save" } })).toThrow("no matching element");
    field.parentElement!.removeAttribute("inert");
    expect(field.value).toBe("");
  });
});
