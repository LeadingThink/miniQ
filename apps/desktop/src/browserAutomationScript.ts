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
    const target = () => {
      if (typeof args.target !== "string" ||
          !args.target.startsWith("rpa-" + expected?.observationId + "-")) {
        throw new Error("target does not belong to the expected observation");
      }
      const node = [...document.querySelectorAll("[data-miniq-rpa-id]")]
        .find((candidate) => candidate.getAttribute("data-miniq-rpa-id") === args.target);
      if (!node) throw new Error("target is no longer present; call snapshot again");
      return node;
    };
    const point = () => {
      const x = Number(args.x);
      const y = Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("invalid pointer coordinates");
      const node = document.elementFromPoint(x, y);
      if (!node) throw new Error("no element exists at the requested coordinates");
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
    const input = (node) => {
      node.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(args.text ?? "") }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
    };
    switch (payload.operation) {
      case "click": {
        if (args.target) target().click();
        else { const p = point(); mouse(p.node, "mousedown", p.x, p.y); mouse(p.node, "mouseup", p.x, p.y); p.node.click(); }
        break;
      }
      case "doubleClick": {
        const p = point();
        mouse(p.node, "mousedown", p.x, p.y); mouse(p.node, "mouseup", p.x, p.y);
        mouse(p.node, "mousedown", p.x, p.y, 2); mouse(p.node, "mouseup", p.x, p.y, 2);
        mouse(p.node, "dblclick", p.x, p.y, 2);
        break;
      }
      case "move": { const p = point(); mouse(p.node, "mousemove", p.x, p.y); break; }
      case "drag": {
        const start = point();
        const endX = Number(args.endX); const endY = Number(args.endY);
        const end = document.elementFromPoint(endX, endY);
        if (!end || !Number.isFinite(endX) || !Number.isFinite(endY)) throw new Error("invalid drag destination");
        mouse(start.node, "mousedown", start.x, start.y);
        mouse(end, "mousemove", endX, endY);
        mouse(end, "mouseup", endX, endY);
        break;
      }
      case "type": {
        const node = target(); node.focus();
        if (args.clear !== false && "value" in node) node.value = "";
        if ("value" in node) node.value += String(args.text ?? "");
        else if (node.isContentEditable) node.textContent = String(args.text ?? "");
        else throw new Error("target does not accept text");
        input(node);
        if (args.submit) node.form?.requestSubmit();
        break;
      }
      case "press": {
        const node = document.activeElement || document.body;
        const options = { key: String(args.key), bubbles: true, cancelable: true,
          altKey: args.modifiers?.includes("alt"), ctrlKey: args.modifiers?.includes("ctrl"),
          metaKey: args.modifiers?.includes("meta"), shiftKey: args.modifiers?.includes("shift") };
        node.dispatchEvent(new KeyboardEvent("keydown", options));
        node.dispatchEvent(new KeyboardEvent("keyup", options));
        break;
      }
      case "scroll": {
        const p = point();
        const scroller = p.node.closest("[style*='overflow']") || document.scrollingElement;
        scroller?.scrollBy({ left: Number(args.deltaX ?? 0), top: Number(args.deltaY ?? 640), behavior: "instant" });
        break;
      }
      case "select": {
        const node = target();
        if (!(node instanceof HTMLSelectElement)) throw new Error("target is not a select element");
        const values = Array.isArray(args.text) ? args.text.map(String) : [String(args.text)];
        for (const option of node.options) option.selected = values.includes(option.value) || values.includes(option.text);
        input(node);
        break;
      }
    }
    document.querySelectorAll("[data-miniq-rpa-id]").forEach((node) => node.removeAttribute("data-miniq-rpa-id"));
    const visible = (node) => {
      const style = getComputedStyle(node); const rect = node.getBoundingClientRect();
      return !node.closest('[aria-hidden="true"], [inert]') && style.visibility !== "hidden" &&
        style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const nodes = [...document.querySelectorAll('a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[contenteditable="true"]')].filter(visible);
    const offset = Number(args.offset ?? 0); const limit = Number(args.limit ?? 100);
    const observationId = String(args.nextObservationId);
    const items = nodes.slice(offset, offset + limit).map((node, index) => {
      const token = "rpa-" + observationId + "-" + (offset + index); node.setAttribute("data-miniq-rpa-id", token);
      const rect = node.getBoundingClientRect(); const sensitive = node.type === "password";
      return { target: token, tag: node.tagName.toLowerCase(), role: node.getAttribute("role"),
        text: sensitive ? "" : String(node.innerText || node.value || "").trim(),
        label: node.getAttribute("aria-label") || [...(node.labels || [])].map((label) => label.innerText).join(" ") || node.getAttribute("title"),
        placeholder: node.getAttribute("placeholder"), type: node.getAttribute("type"), href: node.href || null,
        disabled: Boolean(node.disabled) || node.getAttribute("aria-disabled") === "true", checked: node.checked ?? null,
        selected: node.getAttribute("aria-selected"), bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth };
    });
    const lines = (document.body?.innerText || "").split("\\n");
    return JSON.stringify({ observationId, title: document.title, url: location.href, tabId: payload.tabId,
      documentId, viewport: viewport(), total: nodes.length, offset, limit, items,
      textLines: lines.slice(offset, offset + limit), totalTextLines: lines.length,
      hasMore: offset + limit < Math.max(nodes.length, lines.length) });
  })()`;
}

export function parseBrowserScriptResult(raw: string): BrowserScriptResult {
  const serialized = JSON.parse(raw);
  if (typeof serialized !== "string") throw new Error("内嵌浏览器返回了无效脚本结果");
  return JSON.parse(serialized) as BrowserScriptResult;
}
