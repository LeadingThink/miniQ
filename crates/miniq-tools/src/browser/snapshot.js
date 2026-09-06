(() => {
  const offset = __OFFSET__;
  const limit = __LIMIT__;
  const visible = (node) => {
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return !node.closest('[aria-hidden="true"], [inert]') && style.visibility !== 'hidden'
      && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const nodes = [...document.querySelectorAll('a,button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[contenteditable="true"]')].filter(visible);
  const items = nodes.slice(offset, offset + limit).map((node, index) => {
    const target = `rpa-__OBSERVATION__-${offset + index}`;
    node.setAttribute('data-miniq-rpa-id', target);
    const rect = node.getBoundingClientRect();
    const sensitive = node.type === 'password';
    return {
      target, tag: node.tagName.toLowerCase(), role: node.getAttribute('role'),
      text: sensitive ? '' : (node.innerText || node.value || '').trim(),
      label: node.getAttribute('aria-label') || [...(node.labels || [])].map(label => label.innerText).join(' ') || node.getAttribute('title'),
      placeholder: node.getAttribute('placeholder'), type: node.getAttribute('type'),
      href: node.href || null, disabled: Boolean(node.disabled) || node.getAttribute('aria-disabled') === 'true',
      checked: node.checked ?? null, selected: node.getAttribute('aria-selected'),
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
    };
  });
  const lines = (document.body?.innerText || '').split('\n');
  return JSON.stringify({
    title: document.title, url: location.href, documentId: performance.timeOrigin,
    viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, scrollX, scrollY },
    total: nodes.length, offset, limit, items, textLines: lines.slice(offset, offset + limit),
    totalTextLines: lines.length, hasMore: offset + limit < Math.max(nodes.length, lines.length),
  });
})()
