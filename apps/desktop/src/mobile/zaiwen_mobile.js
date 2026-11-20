// Installed only in miniQ's isolated mobile site view. The fixed navigation
// signal opens the native platform menu; it grants no access to miniQ data.
(() => {
  if (window.top !== window || location.origin !== "https://chat.zaiwenai.com") return;
  if (window.__MINIQ_MOBILE_SWITCH__) return;
  window.__MINIQ_MOBILE_SWITCH__ = true;
  const id = "miniq-mobile-platform-switch";
  function update() {
    if (!document.getElementById(`${id}-style`) && document.head) {
      const style = document.createElement("style");
      style.id = `${id}-style`;
      style.textContent = `
        .layout > .main > .header .mobile-nav-group > strong { display: none !important; }
        .layout > .main > .header .mobile-nav-group { flex-shrink: 0; gap: 2px; }
        #${id} { display: inline-flex; align-items: center; gap: 4px; flex: none;
          min-height: 36px; padding: 0 2px; border: 0; border-radius: 8px;
          background: transparent; color: var(--el-text-color-primary); font: inherit;
          font-size: 16px; font-weight: 650; text-decoration: none; white-space: nowrap; }
        #${id}:focus-visible { outline: 2px solid var(--el-color-primary); }
      `;
      document.head.appendChild(style);
    }
    const group = document.querySelector(".layout > .main > .header .mobile-nav-group");
    if (!group || group.querySelector(`#${id}`)) return;
    const button = document.createElement("a");
    button.id = id;
    button.href = "miniq-platform://menu";
    button.setAttribute("role", "button");
    button.setAttribute("aria-label", "在问，切换平台");
    button.setAttribute("aria-haspopup", "menu");
    button.innerHTML = '在问<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
    button.addEventListener("keydown", event => {
      if (event.key === " ") { event.preventDefault(); button.click(); }
    });
    group.prepend(button);
  }
  new MutationObserver(update).observe(document, { childList: true, subtree: true });
  update();
})();
