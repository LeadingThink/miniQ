// Installed only in miniQ's isolated mobile site view. The fixed navigation
// signal opens the native platform menu; it grants no access to miniQ data.
(() => {
  if (window.top !== window || location.origin !== "https://chat.zaiwenai.com") return;
  if (window.__MINIQ_MOBILE_SWITCH__) return;
  window.__MINIQ_MOBILE_SWITCH__ = true;
  const id = "miniq-mobile-platform-switch";
  const menuId = `${id}-menu`;
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
        #${menuId} { position: fixed; z-index: 2147483647; display: grid; min-width: 260px;
          padding: 12px; border: 1px solid var(--el-border-color, #e4e7ed); border-radius: 16px;
          background: var(--el-bg-color, #fff); box-shadow: 0 16px 40px rgb(0 0 0 / 16%); }
        #${menuId}[hidden] { display: none; }
        #${menuId} a { display: grid; gap: 3px; padding: 12px 14px; border-radius: 10px;
          color: var(--el-text-color-primary, #303133); text-decoration: none; }
        #${menuId} a:hover, #${menuId} a:focus-visible { background: var(--el-fill-color-light, #f5f7fa); outline: none; }
        #${menuId} strong { font-size: 16px; font-weight: 650; }
        #${menuId} small { color: var(--el-text-color-regular, #606266); font-size: 14px; }
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
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const menu = document.getElementById(menuId);
      if (!menu) return;
      const rect = button.getBoundingClientRect();
      menu.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - menu.offsetHeight - 12)}px`;
      menu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 12))}px`;
      menu.hidden = !menu.hidden;
      button.setAttribute("aria-expanded", String(!menu.hidden));
      if (!menu.hidden) menu.querySelector("a")?.focus();
    });
    button.addEventListener("keydown", event => {
      if (event.key === " ") { event.preventDefault(); button.click(); }
    });
    group.prepend(button);
    const menu = document.createElement("div");
    menu.id = menuId;
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "选择平台");
    menu.innerHTML = '<a role="menuitemradio" aria-checked="true" href="https://chat.zaiwenai.com/"><strong>在问</strong><small>创作、学习和探索</small></a><a role="menuitemradio" aria-checked="false" href="miniq-platform://switch/miniq"><strong>miniQ</strong><small>构建、调试和发布</small></a>';
    document.body.append(menu);
    document.addEventListener("click", event => {
      if (menu.hidden || menu.contains(event.target) || event.target === button) return;
      menu.hidden = true;
      button.setAttribute("aria-expanded", "false");
    });
  }
  new MutationObserver(update).observe(document, { childList: true, subtree: true });
  update();
})();
