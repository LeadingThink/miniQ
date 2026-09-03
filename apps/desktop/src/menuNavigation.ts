export type MenuDirection = -1 | 1;

/** Move through a menu with wrap-around, including an initially unset index. */
export function moveMenuIndex(
  current: number,
  itemCount: number,
  direction: MenuDirection,
): number {
  if (itemCount <= 0) return -1;
  if (current < 0 || current >= itemCount) {
    return direction === 1 ? 0 : itemCount - 1;
  }
  return (current + direction + itemCount) % itemCount;
}

export function clampMenuIndex(current: number, itemCount: number): number {
  if (itemCount <= 0) return -1;
  return Math.max(0, Math.min(current, itemCount - 1));
}
