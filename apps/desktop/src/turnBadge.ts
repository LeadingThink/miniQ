import { isTauriRuntime } from "./runtime";
import { isAppInBackground } from "./taskNotifications";

export type TurnBadgeSurface = "icon" | "count" | "none";

export interface IconPixels {
  rgba: Uint8Array;
  width: number;
  height: number;
}

export const BADGED_ICON_SIZE = 64;

/**
 * Windows has no badge count, and its overlay icon is fixed to the bottom-right
 * corner, so the top-right badge is drawn into the window icon itself.
 */
export function turnBadgeSurface(): TurnBadgeSurface {
  if (!isTauriRuntime()) return "none";
  return /Windows/.test(navigator.userAgent) ? "icon" : "count";
}

/** A badge on a ~24px taskbar icon fits one digit legibly. */
export function badgeLabel(count: number): string {
  return count > 9 ? "9+" : String(count);
}

function canvas2d(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas 2d context unavailable");
  return [canvas, context];
}

/** Draws the app icon with a red count badge in its top-right corner. */
export function renderBadgedIcon(base: IconPixels, label: string): Uint8Array {
  const [source, sourceContext] = canvas2d(base.width, base.height);
  const pixels = sourceContext.createImageData(base.width, base.height);
  pixels.data.set(base.rgba);
  sourceContext.putImageData(pixels, 0, 0);
  const size = BADGED_ICON_SIZE;
  const [, context] = canvas2d(size, size);
  context.drawImage(source, 0, 0, size, size);
  const radius = size * 0.26;
  const x = size - radius;
  const y = radius;
  context.fillStyle = "#e53935";
  context.strokeStyle = "#ffffff";
  context.lineWidth = size * 0.04;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.fillStyle = "#ffffff";
  context.font = `bold ${Math.round(radius * (label.length > 1 ? 1.1 : 1.45))}px "Segoe UI", sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, x, y + size * 0.015);
  const { data } = context.getImageData(0, 0, size, size);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

let baseIcon: Promise<IconPixels> | undefined;

function loadBaseIcon(): Promise<IconPixels> {
  baseIcon ??= (async () => {
    const { defaultWindowIcon } = await import("@tauri-apps/api/app");
    const icon = await defaultWindowIcon();
    if (!icon) throw new Error("default window icon unavailable");
    try {
      const [rgba, { width, height }] = await Promise.all([icon.rgba(), icon.size()]);
      return { rgba, width, height };
    } finally {
      await icon.close();
    }
  })().catch((error) => {
    baseIcon = undefined;
    throw error;
  });
  return baseIcon;
}

/** Shows `count` on the app icon; zero restores the original icon. */
export async function showTurnBadge(count: number): Promise<void> {
  const surface = turnBadgeSurface();
  if (surface === "none") return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const window = getCurrentWindow();
  if (surface === "count") {
    await window.setBadgeCount(count > 0 ? count : undefined);
    return;
  }
  const base = await loadBaseIcon();
  const { Image } = await import("@tauri-apps/api/image");
  const image = count > 0
    ? await Image.new(renderBadgedIcon(base, badgeLabel(count)), BADGED_ICON_SIZE, BADGED_ICON_SIZE)
    : await Image.new(base.rgba, base.width, base.height);
  try {
    await window.setIcon(image);
  } finally {
    await image.close();
  }
}

export interface TurnBadge {
  recordTurnEnd(): Promise<void>;
  clear(): void;
}

/** Counts turns that ended while miniQ was in the background. */
export function createTurnBadge(show: (count: number) => Promise<void> = showTurnBadge): TurnBadge {
  let count = 0;
  let queue = Promise.resolve();
  // Serialize native updates so the last requested count always wins.
  const apply = () => {
    const next = count;
    queue = queue.then(() => show(next)).catch(() => undefined);
  };
  return {
    async recordTurnEnd() {
      if (!await isAppInBackground().catch(() => false)) return;
      count += 1;
      apply();
    },
    clear() {
      if (count === 0) return;
      count = 0;
      apply();
    },
  };
}

/** Clears the badge whenever the user returns to the desktop window. */
export function clearTurnBadgeOnFocus(badge: TurnBadge): () => void {
  const onFocus = () => badge.clear();
  window.addEventListener("focus", onFocus);
  let disposed = false;
  let unlistenNative: (() => void) | undefined;
  if (isTauriRuntime()) {
    // An embedded child webview can take focus without focusing this document.
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().onFocusChanged(({ payload }) => { if (payload) badge.clear(); }))
      .then((unlisten) => { if (disposed) unlisten(); else unlistenNative = unlisten; })
      .catch(() => undefined);
  }
  return () => {
    disposed = true;
    window.removeEventListener("focus", onFocus);
    unlistenNative?.();
  };
}
