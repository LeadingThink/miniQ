/** A visual automation pointer owned by one document, never the OS cursor. */
export const browserPointerScript = String.raw`
    const showBrowserPointer = (x, y, action) => {
      const key = "__miniqBrowserPointer";
      const transform = "translate(" + (x - 3) + "px," + (y - 3) + "px)";
      let state = document[key];
      if (!state) {
        const host = document.createElement("miniq-browser-pointer");
        host.setAttribute("data-miniq-browser-pointer", "");
        host.setAttribute("aria-hidden", "true");
        host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;" +
          "z-index:2147483647!important;pointer-events:none!important;overflow:hidden!important;" +
          "user-select:none!important;contain:strict!important;";
        const root = host.attachShadow({ mode: "closed" });
        const pointer = document.createElement("div");
        pointer.style.cssText = "position:absolute;left:0;top:0;pointer-events:none;" +
          "opacity:0;transition:transform 120ms ease-out,opacity 180ms ease;will-change:transform;";
        pointer.style.transform = transform;
        const glow = document.createElement("div");
        glow.style.cssText = "position:absolute;left:-22px;top:-22px;width:64px;height:64px;" +
          "pointer-events:none;filter:blur(3px);background:radial-gradient(circle," +
          "rgba(77,163,255,.4) 0%,rgba(77,163,255,.2) 28%,rgba(77,163,255,.06) 50%,transparent 72%);";
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("width", "22");
        svg.setAttribute("height", "24");
        svg.setAttribute("viewBox", "0 0 26 28");
        svg.style.cssText = "position:relative;display:block;overflow:visible;filter:drop-shadow(0 1px 2px #0005);";
        const arrow = document.createElementNS(svg.namespaceURI, "path");
        arrow.setAttribute("d", "M4.4 3.1 L21.4 9.6 C22.8 10.1 22.8 12.1 21.3 12.6 L15.2 14.8 L13 20.9 C12.5 22.4 10.5 22.4 10 21 L3.5 4 C3.2 3.3 3.7 2.8 4.4 3.1 Z");
        arrow.setAttribute("fill", "#111315");
        arrow.setAttribute("stroke", "#fff");
        arrow.setAttribute("stroke-width", "2.2");
        arrow.setAttribute("stroke-linejoin", "round");
        svg.append(arrow);
        pointer.append(glow, svg);
        root.append(pointer);
        state = { host, pointer, timer: undefined };
        Object.defineProperty(document, key, { value: state, configurable: true });
        window.addEventListener("pagehide", () => {
          window.clearTimeout(state.timer);
          host.remove();
          delete document[key];
        }, { once: true });
      }
      // Reattach after an SPA replaces its document contents. Each WebView has its own state.
      if (!state.host.isConnected) document.documentElement.append(state.host);
      state.pointer.style.transitionDuration = action === "drag" ? "260ms,180ms" : "120ms,180ms";
      // Commit the start position so a same-script drag visibly travels to its destination.
      state.pointer.getBoundingClientRect();
      state.pointer.style.transform = transform;
      state.pointer.style.opacity = "1";
      window.clearTimeout(state.timer);
      state.timer = window.setTimeout(() => { state.pointer.style.opacity = "0"; }, 1800);
    };
`;
