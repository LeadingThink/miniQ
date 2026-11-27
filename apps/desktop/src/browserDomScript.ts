/** Shared DOM semantics for observations and direct element actions in every WebView. */
export const browserDomScript = String.raw`
    const descendants = (root = document) => {
      const nodes = [];
      for (const node of root.querySelectorAll("*")) {
        if (node.hasAttribute("data-miniq-browser-pointer")) continue;
        nodes.push(node);
        if (node.shadowRoot) nodes.push(...descendants(node.shadowRoot));
      }
      return nodes;
    };
    const parentOf = (node) => node.parentElement || node.getRootNode()?.host || null;
    const isNativeChoice = (node) => node.tagName === "INPUT" &&
      ["radio", "checkbox"].includes(String(node.type).toLowerCase());
    const boundsOf = (node) => {
      const rect = node.getBoundingClientRect();
      if ((rect.width > 0 && rect.height > 0) || !isNativeChoice(node)) return rect;
      return node.parentElement?.parentElement?.getBoundingClientRect() || rect;
    };
    const visible = (node) => {
      let ancestor = node;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        if (ancestor.hidden || ancestor.inert || ancestor.hasAttribute("inert") ||
            style.visibility === "hidden" || style.display === "none" ||
            (ancestor.getAttribute("aria-hidden") === "true" && !(ancestor === node && isNativeChoice(node)))) return false;
        ancestor = parentOf(ancestor);
      }
      const rect = node.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
      if (!isNativeChoice(node)) return false;
      let parent = parentOf(node);
      while (parent && parent !== document.body) {
        const rect = parent.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return true;
        parent = parentOf(parent);
      }
      return false;
    };
    const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const readableText = (node) => normalize(node.innerText || node.textContent || "");
    const accessibleLabel = (node) => {
      const ids = (node.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
      const root = node.getRootNode();
      const labelled = ids.map((id) => root.getElementById?.(id)).filter(Boolean).map(readableText).join(" ");
      const labels = [...(node.labels || [])].map(readableText).filter(Boolean).join(" ");
      const nearby = isNativeChoice(node) ? node.parentElement?.parentElement
        ?.querySelector('[class*="radio__label"], [class*="checkbox__label"], label, [class*="option-title"]') : null;
      return normalize(labelled || node.getAttribute("aria-label") || labels ||
        (nearby && readableText(nearby)) || node.getAttribute("title")) || null;
    };
    const roleOf = (node) => {
      const explicit = node.getAttribute("role");
      if (explicit) return explicit.split(/\s+/)[0];
      switch (node.tagName) {
        case "BUTTON": case "SUMMARY": return "button";
        case "A": return node.hasAttribute("href") ? "link" : null;
        case "TEXTAREA": return "textbox";
        case "SELECT": return node.multiple || node.size > 1 ? "listbox" : "combobox";
        case "OPTION": return "option";
        case "IMG": return "img";
        case "INPUT":
          if (["checkbox", "radio"].includes(node.type)) return node.type;
          if (["button", "submit", "reset", "image"].includes(node.type)) return "button";
          if (node.hasAttribute("list")) return "combobox";
          if (node.type === "range") return "slider";
          if (node.type === "number") return "spinbutton";
          if (node.type === "search") return "searchbox";
          return ["hidden", "password", "file", "color", "date", "time"].includes(node.type) ? null : "textbox";
        default:
          if (/^H[1-6]$/.test(node.tagName)) return "heading";
          return node.isContentEditable ? "textbox" : null;
      }
    };
    const accessibleName = (node) => accessibleLabel(node) ||
      (node.tagName === "IMG" ? normalize(node.getAttribute("alt")) :
       node.tagName === "INPUT" && ["button", "submit", "reset"].includes(node.type) ? normalize(node.value) :
       ["INPUT", "TEXTAREA", "SELECT"].includes(node.tagName) ? "" : readableText(node));
    const disabled = (node) => {
      if (node.disabled || node.matches(":disabled")) return true;
      for (let ancestor = node; ancestor; ancestor = parentOf(ancestor)) {
        if (ancestor.getAttribute("aria-disabled") === "true") return true;
      }
      return false;
    };
    const assertEnabled = (node) => { if (disabled(node)) throw new Error("target is disabled"); };
    const resolveElement = (target, locator) => {
      const nodes = descendants();
      if (locator) {
        const matches = (actual, wanted) => locator.exact === false
          ? normalize(actual).includes(normalize(wanted)) : normalize(actual) === normalize(wanted);
        const candidates = nodes.filter(visible).filter((node) => {
          let match;
          switch (locator.by) {
            case "role": match = roleOf(node) === locator.value; break;
            case "label": match = matches(accessibleLabel(node), locator.value); break;
            case "text": match = matches(readableText(node), locator.value) &&
              ![...node.children].some((child) => visible(child) && matches(readableText(child), locator.value)); break;
            case "placeholder": match = matches(node.getAttribute("placeholder"), locator.value); break;
            case "testId": match = node.getAttribute("data-testid") === locator.value; break;
            case "css": match = node.matches(locator.value); break;
            default: throw new Error("unsupported locator");
          }
          return match && (locator.name === undefined || matches(accessibleName(node), locator.name));
        });
        if (!candidates.length) throw new Error("no matching element; inspect the DOM snapshot and refine the locator");
        if (candidates.length !== 1) throw new Error("ambiguous locator: " + candidates.length + " matching elements; refine the locator");
        return candidates[0];
      }
      if (typeof target !== "string" || !target.startsWith("rpa-" + expected?.observationId + "-")) {
        throw new Error("target does not belong to the expected observation");
      }
      const node = nodes.find((node) => node.getAttribute("data-miniq-rpa-id") === target);
      if (!node || !visible(node)) throw new Error("target is no longer present; call snapshot again");
      return node;
    };
`;
