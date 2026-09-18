// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildBrowserAutomationScript,
  parseBrowserScriptResult,
} from "./browserAutomationScript";

function execute(operation: string, arguments_: Record<string, unknown>) {
  const script = buildBrowserAutomationScript(operation, arguments_, "tab-1");
  return parseBrowserScriptResult(JSON.stringify(eval(script)));
}

describe("embedded browser automation script", () => {
  beforeEach(() => {
    document.body.innerHTML = '<button id="save">Save</button>';
    Object.defineProperty(document.body, "innerText", {
      configurable: true,
      value: "Save",
    });
    const button = document.querySelector("button")!;
    Object.defineProperty(button, "innerText", {
      configurable: true,
      value: "Save",
    });
    button.getBoundingClientRect = () =>
      ({ x: 10, y: 20, width: 80, height: 30, top: 20, left: 10, right: 90, bottom: 50 }) as DOMRect;
  });

  afterEach(() => vi.restoreAllMocks());

  it("creates observation-bound targets", () => {
    const result = execute("snapshot", {
      nextObservationId: "observation-1",
      offset: 0,
      limit: 100,
    });
    expect(result.observationId).toBe("observation-1");
    expect(result.tabId).toBe("tab-1");
    expect(result.items).toEqual([
      expect.objectContaining({ target: "rpa-observation-1-0", text: "Save" }),
    ]);
  });

  it("rejects an undefined or incomplete native WebView result", () => {
    expect(() => parseBrowserScriptResult(JSON.stringify("null"))).toThrow("不完整");
    expect(() => parseBrowserScriptResult(JSON.stringify(JSON.stringify({ observationId: "x" })))).toThrow("不完整");
  });

  it("keeps a stable identity for the current document", () => {
    const first = execute("snapshot", { nextObservationId: "observation-1" });
    const second = execute("snapshot", { nextObservationId: "observation-2" });

    expect(first.documentId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(second.documentId).toBe(first.documentId);
    expect(first.documentId).not.toBe(String(performance.timeOrigin));
  });

  it("clicks only a target from the expected observation", () => {
    const click = vi.fn();
    document.querySelector("button")!.addEventListener("click", click);
    const observed = execute("snapshot", { nextObservationId: "observation-1" });
    execute("click", {
      nextObservationId: "observation-2",
      observationId: "observation-1",
      target: "rpa-observation-1-0",
      expectedObservation: observed,
    });
    expect(click).toHaveBeenCalledOnce();
  });

  it("rejects stale page state before interaction", () => {
    const observed = execute("snapshot", { nextObservationId: "observation-1" });
    expect(() =>
      execute("click", {
        nextObservationId: "observation-2",
        observationId: "observation-1",
        target: "rpa-observation-1-0",
        expectedObservation: { ...observed, documentId: "replaced-document" },
      }),
    ).toThrow("stale observation");
  });

  it("uses the native value setter and emits input for controlled form fields", () => {
    document.body.innerHTML = '<input id="name" value="old">';
    const field = document.querySelector("input")!;
    field.getBoundingClientRect = () =>
      ({ x: 10, y: 20, width: 120, height: 30, top: 20, left: 10, right: 130, bottom: 50 }) as DOMRect;
    const events: string[] = [];
    field.addEventListener("input", () => events.push("input"));
    field.addEventListener("change", () => events.push("change"));
    const observed = execute("snapshot", { nextObservationId: "observation-1" });
    execute("type", {
      nextObservationId: "observation-2",
      observationId: "observation-1",
      target: "rpa-observation-1-0",
      expectedObservation: observed,
      text: "new",
    });
    expect(field.value).toBe("new");
    expect(events).toEqual(["input", "change"]);
  });

  it("exposes native and ARIA questionnaire controls with their choices", () => {
    document.body.innerHTML = `
      <fieldset>
        <label for="founder">创始人姓名</label><input id="founder" name="founder" value="张三">
        <label><input id="choice" type="radio" name="stage" value="seed"> 种子期</label>
        <div id="custom" role="checkbox" aria-label="已完成商业计划书" aria-checked="false" tabindex="0">已完成</div>
        <select id="stage"><option value="a">早期</option><option value="b">成长期</option></select>
      </fieldset>`;
    for (const element of document.querySelectorAll<HTMLElement>("input,select,label,[role=checkbox]")) {
      element.getBoundingClientRect = () =>
        ({ x: 10, y: 20, width: 120, height: 30, top: 20, left: 10, right: 130, bottom: 50 }) as DOMRect;
    }
    const result = execute("snapshot", { nextObservationId: "observation-1" });
    const items = result.items as Array<Record<string, unknown>>;
    expect(items.some((item) => item.type === "radio" && item.label === "种子期")).toBe(true);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "checkbox", ariaChecked: "false", label: "已完成商业计划书" }),
      expect.objectContaining({ tag: "select", options: [
        { text: "早期", value: "a", selected: true },
        { text: "成长期", value: "b", selected: false },
      ] }),
    ]));
  });

  it("keeps zero-size aria-hidden radio controls addressable through their visible option", () => {
    document.body.innerHTML = `
      <div class="option" id="option">
        <span class="ws-radio__input"><input aria-hidden="true" type="radio" value="yes"></span>
        <span class="ws-radio__label">同意参加</span>
      </div>`;
    const option = document.querySelector<HTMLElement>("#option")!;
    option.getBoundingClientRect = () =>
      ({ x: 10, y: 20, width: 180, height: 32, top: 20, left: 10, right: 190, bottom: 52 }) as DOMRect;
    const result = execute("snapshot", { nextObservationId: "observation-1" });
    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "radio", label: "同意参加", bounds: expect.objectContaining({ width: 180 }) }),
    ]));
  });

  it("activates custom checkbox controls through their target", () => {
    document.body.innerHTML = '<div id="custom" role="checkbox" aria-checked="false">完成</div>';
    const control = document.querySelector<HTMLElement>("[role=checkbox]")!;
    control.getBoundingClientRect = () =>
      ({ x: 10, y: 20, width: 120, height: 30, top: 20, left: 10, right: 130, bottom: 50 }) as DOMRect;
    control.addEventListener("click", () => control.setAttribute("aria-checked", "true"));
    const observed = execute("snapshot", { nextObservationId: "observation-1" });
    const target = (observed.items as Array<Record<string, unknown>>)[0].target;
    execute("click", {
      nextObservationId: "observation-2",
      observationId: "observation-1",
      target,
      expectedObservation: observed,
    });
    expect(control.getAttribute("aria-checked")).toBe("true");
  });

  it("selects options by value or visible label and emits native events", () => {
    document.body.innerHTML = '<select id="stage"><option value="a">早期</option><option value="b">成长期</option></select>';
    const select = document.querySelector<HTMLSelectElement>("select")!;
    select.getBoundingClientRect = () =>
      ({ x: 10, y: 20, width: 120, height: 30, top: 20, left: 10, right: 130, bottom: 50 }) as DOMRect;
    const events: string[] = [];
    select.addEventListener("input", () => events.push("input"));
    select.addEventListener("change", () => events.push("change"));
    const observed = execute("snapshot", { nextObservationId: "observation-1" });
    const target = (observed.items as Array<Record<string, unknown>>).find((item) => item.tag === "select")!.target;
    execute("select", {
      nextObservationId: "observation-2",
      observationId: "observation-1",
      target,
      expectedObservation: observed,
      text: "成长期",
    });
    expect(select.value).toBe("b");
    expect(events).toEqual(["input", "change"]);
  });

  it("does not silently clear a select when an option label is wrong", () => {
    document.body.innerHTML = '<select id="stage"><option value="a">早期</option><option value="b">成长期</option></select>';
    const select = document.querySelector<HTMLSelectElement>("select")!;
    select.getBoundingClientRect = () =>
      ({ x: 10, y: 20, width: 120, height: 30, top: 20, left: 10, right: 130, bottom: 50 }) as DOMRect;
    const observed = execute("snapshot", { nextObservationId: "observation-1" });
    const target = (observed.items as Array<Record<string, unknown>>).find((item) => item.tag === "select")!.target;
    expect(() => execute("select", {
      nextObservationId: "observation-2",
      observationId: "observation-1",
      target,
      expectedObservation: observed,
      text: "不存在的选项",
    })).toThrow("no matching option");
    expect(select.value).toBe("a");
  });

  it("supports multi-select values without accepting an array in the text field", () => {
    document.body.innerHTML = '<select id="stage" multiple><option value="a">早期</option><option value="b">成长期</option><option value="c">成熟期</option></select>';
    const select = document.querySelector<HTMLSelectElement>("select")!;
    select.getBoundingClientRect = () =>
      ({ x: 10, y: 20, width: 120, height: 30, top: 20, left: 10, right: 130, bottom: 50 }) as DOMRect;
    const observed = execute("snapshot", { nextObservationId: "observation-1" });
    const target = (observed.items as Array<Record<string, unknown>>).find((item) => item.tag === "select")!.target;
    execute("select", {
      nextObservationId: "observation-2",
      observationId: "observation-1",
      target,
      expectedObservation: observed,
      values: ["早期", "c"],
    });
    expect([...select.selectedOptions].map((option) => option.value)).toEqual(["a", "c"]);
  });

  it("rejects a partially matching multi-select without changing the current selection", () => {
    document.body.innerHTML = '<select multiple><option value="a">早期</option><option value="b" selected>成长期</option></select>';
    const select = document.querySelector<HTMLSelectElement>("select")!;
    select.getBoundingClientRect = () =>
      ({ x: 10, y: 20, width: 120, height: 30, top: 20, left: 10, right: 130, bottom: 50 }) as DOMRect;
    const observed = execute("snapshot", { nextObservationId: "observation-1" });
    const target = (observed.items as Array<Record<string, unknown>>).find((item) => item.tag === "select")!.target;
    const onChange = vi.fn();
    select.addEventListener("change", onChange);
    expect(() => execute("select", {
      nextObservationId: "observation-2",
      observationId: "observation-1",
      target,
      expectedObservation: observed,
      values: ["a", "不存在的选项"],
    })).toThrow("no matching option");
    expect([...select.selectedOptions].map((option) => option.value)).toEqual(["b"]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rejects disabled questionnaire controls before dispatching a click", () => {
    document.body.innerHTML = '<button id="next" disabled>下一页</button>';
    const button = document.querySelector<HTMLButtonElement>("button")!;
    button.getBoundingClientRect = () =>
      ({ x: 10, y: 20, width: 120, height: 30, top: 20, left: 10, right: 130, bottom: 50 }) as DOMRect;
    const observed = execute("snapshot", { nextObservationId: "observation-1" });
    expect(() => execute("click", {
      nextObservationId: "observation-2",
      observationId: "observation-1",
      target: (observed.items as Array<Record<string, unknown>>)[0].target,
      expectedObservation: observed,
    })).toThrow("target is disabled");
  });
});
