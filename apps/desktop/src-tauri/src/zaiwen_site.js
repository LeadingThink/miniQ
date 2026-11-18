// Only installed in miniQ's dedicated main-site view. Other browser tabs and
// pages reached through authentication redirects keep their original UI.
(() => {
  if (window.top !== window || location.origin !== "https://chat.zaiwenai.com") return;
  if (window.__MINIQ_ZAIWEN_CHAT__) return;
  window.__MINIQ_ZAIWEN_CHAT__ = true;

  const styleId = "miniq-zaiwen-chat-style";
  const hiddenAttribute = "data-miniq-hidden-navigation";
  const hiddenTitles = new Set(["艺术创作", "发现"]);
  const chat = ".route-page > .index > .content";
  const guide = `${chat} > .dialogue-region > .message-box > .scroll > .scroll-container > .guide`;
  const composer = `${chat} > .dialogue-region ~ .input-region > .input-box`;
  const hiddenChatSelectors = [
    `${guide} > :not(.header)`,
    `${guide} > .header > .refresh-btn`,
    `${chat} > .dialogue-region ~ .func-region`,
    `${composer} > .intent-chip`,
    `${composer} > .input-bottom-bar [data-testid="deep-search-toggle"]`,
    `${composer} > .input-bottom-bar [data-testid="agent-toggle"]`,
    `${composer} > .input-bottom-bar > .right > .tooltip-trigger:has(> .h-optimize)`,
  ];

  function updatePage() {
    if (!document.getElementById(styleId) && document.head) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
        .sidebar .menus > [${hiddenAttribute}],
        ${hiddenChatSelectors.join(",\n")} { display: none !important; }
      `;
      document.head.appendChild(style);
    }
    // The site renders navigation as role=link divs, without hrefs. Restrict
    // matching to menu titles so chat messages and history names are untouched.
    for (const item of document.querySelectorAll('.sidebar .menus > .menu[role="link"]')) {
      const title = item.querySelector(":scope > .title")?.textContent.trim();
      item.toggleAttribute(hiddenAttribute, hiddenTitles.has(title));
    }
  }

  // Installed at document start; also covers Vue mounting, sidebar expansion,
  // mobile navigation and subsequent client-side navigation.
  new MutationObserver(updatePage).observe(document, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  updatePage();
})();
