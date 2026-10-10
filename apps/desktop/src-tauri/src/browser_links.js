(() => {
  // Links that target another window must open a new miniQ tab. Re-issue
  // them as window.open while the click's user gesture is still active, so
  // WebKit's popup rules never swallow them and every engine reaches the
  // native new-window handler (Rust emits browser://new-window and denies
  // the native window). Keep a reference taken before page scripts run, in
  // case a page replaces window.open.
  const openWindow = window.open.bind(window);
  document.addEventListener("click", (event) => {
    if (event.button !== 0 || event.defaultPrevented) return;
    const anchor = event.target instanceof Element
      ? event.target.closest("a[href]")
      : null;
    if (!anchor || anchor.hasAttribute("download")) return;
    const target = anchor.getAttribute("target") ||
      document.querySelector("base[target]")?.getAttribute("target");
    if (!target || ["_self", "_top", "_parent"].includes(target.toLowerCase())) return;
    const url = new URL(anchor.href, location.href);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openWindow(url.href, "_blank", "noopener");
  }, true);
})();
