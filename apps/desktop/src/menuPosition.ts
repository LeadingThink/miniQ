export function menuPosition(
  trigger: { left: number; top: number; bottom: number },
  menu: { width: number; height: number },
  viewport: {
    width: number;
    height: number;
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
  },
  gap = 8,
) {
  const leftEdge = viewport.left ?? 0;
  const rightEdge = viewport.right ?? viewport.width;
  const topEdge = viewport.top ?? 0;
  const bottomEdge = viewport.bottom ?? viewport.height;
  const below = Math.max(0, bottomEdge - trigger.bottom - gap * 2);
  const above = Math.max(0, trigger.top - topEdge - gap * 2);
  const openAbove = above >= menu.height || above > below;
  const maxHeight = openAbove ? above : below;
  return {
    left: Math.max(
      leftEdge + gap,
      Math.min(trigger.left, rightEdge - menu.width - gap),
    ),
    top: openAbove
      ? Math.max(topEdge + gap, trigger.top - Math.min(menu.height, maxHeight) - gap)
      : Math.max(topEdge + gap, trigger.bottom + gap),
    maxHeight,
  };
}
