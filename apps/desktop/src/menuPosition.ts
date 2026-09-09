export function menuPosition(
  trigger: { left: number; top: number; bottom: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const gap = 8;
  const below = Math.max(0, viewport.height - trigger.bottom - gap * 2);
  const above = Math.max(0, trigger.top - gap * 2);
  const openAbove = above >= menu.height || above > below;
  const maxHeight = openAbove ? above : below;
  return {
    left: Math.max(
      gap,
      Math.min(trigger.left, viewport.width - menu.width - gap),
    ),
    top: openAbove
      ? Math.max(gap, trigger.top - Math.min(menu.height, maxHeight) - gap)
      : Math.max(gap, trigger.bottom + gap),
    maxHeight,
  };
}
