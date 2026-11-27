import { browserDomScript } from "./browserDomScript";
import { browserPointerScript } from "./browserPointerScript";

export interface BrowserScriptResult {
  [key: string]: unknown;
  observationId: string;
  url: string;
  tabId: string;
  documentId: string;
  title: string;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    scrollX: number;
    scrollY: number;
  };
  total: number;
  offset: number;
  limit: number;
  items: unknown[];
  textLines: string[];
  totalTextLines: number;
  hasMore: boolean;
  readyState: DocumentReadyState;
}

export function buildBrowserAutomationScript(
  operation: string,
  arguments_: Record<string, unknown>,
  tabId: string,
): string {
  const payload = JSON.stringify({ operation, arguments: arguments_, tabId });
  return `(() => {
    const payload = ${payload};
    const args = payload.arguments;
    const documentIdKey = "__miniqBrowserDocumentId";
    if (!Object.prototype.hasOwnProperty.call(document, documentIdKey)) {
      Object.defineProperty(document, documentIdKey, {
        value: crypto.randomUUID(),
        configurable: false,
        enumerable: false,
        writable: false,
      });
    }
    const documentId = document[documentIdKey];
    const viewport = () => ({
      width: innerWidth,
      height: innerHeight,
      deviceScaleFactor: devicePixelRatio,
      scrollX,
      scrollY,
    });
    const expected = args.expectedObservation;
    if (expected) {
      const actual = { url: location.href, documentId, viewport: viewport() };
      const sameViewport = ["width", "height", "scrollX", "scrollY"]
        .every((key) => Math.abs(Number(actual.viewport[key]) - Number(expected.viewport?.[key])) < 0.5);
      if (expected.url !== actual.url || expected.documentId !== actual.documentId ||
          expected.tabId !== payload.tabId || !sameViewport) {
        throw new Error("stale observation; call snapshot and use its observationId");
      }
    }
    ${browserDomScript}
    ${browserPointerScript}
    const target = () => resolveElement(args.target, args.locator);
    const point = (token = args.target, locator = args.locator, x = args.x, y = args.y) => {
      if (token || locator) {
        const node = resolveElement(token, locator);
        assertEnabled(node);
        const rect = boundsOf(node);
        return { node, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("invalid pointer coordinates");
      const node = document.elementFromPoint(x, y);
      if (!node) throw new Error("no element exists at the requested coordinates");
      assertEnabled(node);
      return { node, x, y };
    };
    const mouse = (node, type, x, y, detail = 1) => node.dispatchEvent(new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      detail,
      button: args.button === "right" ? 2 : args.button === "middle" ? 1 : 0,
      altKey: args.modifiers?.includes("alt"),
      ctrlKey: args.modifiers?.includes("ctrl"),
      metaKey: args.modifiers?.includes("meta"),
      shiftKey: args.modifiers?.includes("shift"),
    }));
    const input = (node, data = String(args.text ?? "")) => {
      // Selects do not accept InputEvent's text metadata.  A plain bubbling
      // event is what native forms and controlled React/Vue selects expect.
      if (node instanceof HTMLSelectElement) {
        node.dispatchEvent(new Event("input", { bubbles: true }));
      } else {
        node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data }));
      }
      node.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const setNativeValue = (node, value) => {
      // Calling the prototype setter keeps React/Vue controlled inputs in sync;
      // assigning node.value directly only changes the DOM property and can be
      // discarded on the next render. Plain HTML inputs use the same path.
      const prototype = node instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(node, value);
      else node.value = value;
    };
    const setNativeSelect = (node, values) => {
      const selected = new Set(values.map((value) => String(value).trim()));
      const options = [...node.options];
      const matchesValue = (candidate, value) => candidate.value === value ||
        candidate.label.trim() === value || String(candidate.textContent || "").trim() === value;
      if ([...selected].some((value) => !options.some((candidate) => matchesValue(candidate, value)))) {
        throw new Error("no matching option for select target");
      }
      const matches = options.filter((candidate) => [...selected].some((value) => matchesValue(candidate, value)));
      if (!node.multiple && matches.length > 1) {
        throw new Error("select target accepts only one option");
      }
      if (!node.multiple) {
        const option = matches[0];
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
        if (setter && option) setter.call(node, option.value);
        else if (option) node.value = option.value;
        return;
      }
      for (const option of options) option.selected = matches.includes(option);
    };
    const activate = ({ node, x, y }) => {
      assertEnabled(node);
      // Keep target clicks equivalent to coordinate clicks.  Some survey
      // widgets commit their value on mousedown/mouseup while native inputs
      // and framework controls still receive their normal click activation.
      mouse(node, "mousedown", x, y);
      mouse(node, "mouseup", x, y);
      node.click();
    };
    const scrollParent = (node) => {
      let current = node;
      while (current && current !== document.body) {
        const style = getComputedStyle(current);
        if ((style.overflowY === "auto" || style.overflowY === "scroll" ||
             style.overflow === "auto" || style.overflow === "scroll") &&
            current.scrollHeight > current.clientHeight) return current;
        current = parentOf(current);
      }
      return document.scrollingElement;
    };
    switch (payload.operation) {
      case "click": {
        const p = point();
        showBrowserPointer(p.x, p.y, "click");
        activate(p);
        break;
      }
      case "doubleClick": {
        const p = point();
        showBrowserPointer(p.x, p.y, "doubleClick");
        activate(p); activate(p);
        mouse(p.node, "dblclick", p.x, p.y, 2);
        break;
      }
      case "move": {
        const p = point();
        showBrowserPointer(p.x, p.y, "move");
        mouse(p.node, "mousemove", p.x, p.y);
        break;
      }
      case "drag": {
        const start = point();
        const end = point(args.endTarget ?? null, args.endLocator ?? null, args.endX, args.endY);
        showBrowserPointer(start.x, start.y, "drag");
        mouse(start.node, "mousedown", start.x, start.y);
        showBrowserPointer(end.x, end.y, "drag");
        mouse(end.node, "mousemove", end.x, end.y);
        mouse(end.node, "mouseup", end.x, end.y);
        break;
      }
      case "type": {
        const node = target();
        assertEnabled(node);
        if (node.readOnly) throw new Error("target is read-only");
        if (node.type === "file") throw new Error("file inputs require a file chooser");
        if (!("value" in node) && !node.isContentEditable) throw new Error("target does not accept text");
        const rect = boundsOf(node);
        showBrowserPointer(rect.left + rect.width / 2, rect.top + rect.height / 2, "type");
        node.focus();
        if ("value" in node) {
          const current = args.clear !== false ? "" : String(node.value ?? "");
          setNativeValue(node, current + String(args.text ?? ""));
        }
        else if (node.isContentEditable) node.textContent = String(args.text ?? "");
        input(node);
        if (args.submit) node.form?.requestSubmit();
        break;
      }
      case "press": {
        const node = args.target || args.locator ? target() : document.activeElement || document.body;
        assertEnabled(node);
        if (args.target || args.locator) {
          const rect = boundsOf(node);
          showBrowserPointer(rect.left + rect.width / 2, rect.top + rect.height / 2, "press");
        }
        node.focus();
        const options = { key: String(args.key), bubbles: true, cancelable: true,
          altKey: args.modifiers?.includes("alt"), ctrlKey: args.modifiers?.includes("ctrl"),
          metaKey: args.modifiers?.includes("meta"), shiftKey: args.modifiers?.includes("shift") };
        node.dispatchEvent(new KeyboardEvent("keydown", options));
        node.dispatchEvent(new KeyboardEvent("keypress", options));
        node.dispatchEvent(new KeyboardEvent("keyup", options));
        break;
      }
      case "scroll": {
        const p = point();
        showBrowserPointer(p.x, p.y, "scroll");
        const scroller = scrollParent(p.node);
        scroller?.scrollBy({ left: Number(args.deltaX ?? 0), top: Number(args.deltaY ?? 640), behavior: "instant" });
        break;
      }
      case "select": {
        const node = target();
        if (!(node instanceof HTMLSelectElement)) throw new Error("target is not a select element");
        assertEnabled(node);
        const values = Array.isArray(args.values)
          ? args.values.map(String)
          : [String(args.text ?? "")];
        setNativeSelect(node, values);
        const rect = boundsOf(node);
        showBrowserPointer(rect.left + rect.width / 2, rect.top + rect.height / 2, "select");
        input(node, values.join(", "));
        break;
      }
    }
    // Keep the targets from this observation alive until the next observation
    // is taken.  Removing them here makes every subsequent target-bound action
    // fail immediately: the model receives a valid token, but the next script
    // cannot resolve it.  A fresh snapshot replaces all tokens on the nodes it
    // exposes and clears tokens from nodes it no longer exposes first, so an
    // old observation still cannot be reused.
    if (payload.operation === "snapshot") {
      descendants().filter((node) => node.hasAttribute("data-miniq-rpa-id")).forEach((node) => node.removeAttribute("data-miniq-rpa-id"));
    }
    const nodes = descendants().filter((node) => node.matches('a,button,input,textarea,select,summary,label,option,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[role="textbox"],[role="option"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="tab"],[role="menuitem"],[contenteditable="true"]'))
      .filter(visible)
      .filter((node) => node.tagName.toLowerCase() !== "label" || node.control || node.getAttribute("for") || node.getAttribute("role"));
    const offset = Number(args.offset ?? 0); const limit = Number(args.limit ?? 100);
    const observationId = String(args.nextObservationId);
    const items = nodes.slice(offset, offset + limit).map((node, index) => {
      const token = "rpa-" + observationId + "-" + (offset + index); node.setAttribute("data-miniq-rpa-id", token);
      const rect = boundsOf(node);
      const sensitive = node.type === "password";
      return { target: token, tag: node.tagName.toLowerCase(), role: roleOf(node),
        text: sensitive ? "" : readableText(node),
        label: accessibleLabel(node), accessibleName: accessibleName(node),
        testId: node.getAttribute("data-testid"),
        placeholder: node.getAttribute("placeholder"), type: node.getAttribute("type"), href: node.href || null,
        name: node.getAttribute("name"), id: node.id || null, required: Boolean(node.required),
        disabled: disabled(node), checked: node.checked ?? null,
        ariaChecked: node.getAttribute("aria-checked"), selected: node.getAttribute("aria-selected"),
        value: sensitive ? "" : ("value" in node ? String(node.value ?? "") : null),
        options: node instanceof HTMLSelectElement ? [...node.options].map((option) => ({ text: option.text, value: option.value, selected: option.selected })) : undefined,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth };
    });
    const lines = (document.body?.innerText || "").split("\\n");
    return JSON.stringify({ observationId, title: document.title, url: location.href, tabId: payload.tabId,
      documentId, viewport: viewport(), readyState: document.readyState, total: nodes.length, offset, limit, items,
      textLines: lines.slice(offset, offset + limit), totalTextLines: lines.length,
      hasMore: offset + limit < Math.max(nodes.length, lines.length) });
  })()`;
}

export function parseBrowserScriptResult(raw: string): BrowserScriptResult {
  const serialized = JSON.parse(raw);
  if (typeof serialized !== "string") throw new Error("内嵌浏览器返回了无效脚本结果");
  const result = JSON.parse(serialized) as Partial<BrowserScriptResult> | null;
  if (!result || typeof result !== "object" || typeof result.observationId !== "string" ||
      typeof result.documentId !== "string" || typeof result.url !== "string") {
    throw new Error("内嵌浏览器返回了不完整的页面观察");
  }
  return result as BrowserScriptResult;
}
