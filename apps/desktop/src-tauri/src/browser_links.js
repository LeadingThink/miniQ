(() => {
  document.addEventListener("click", (event) => {
    if (event.button !== 0) return;
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
    location.assign(url.href);
  }, true);
})();