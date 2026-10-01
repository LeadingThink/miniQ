// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BADGED_ICON_SIZE, badgeLabel, clearTurnBadgeOnFocus, createTurnBadge, showTurnBadge, turnBadgeSurface } from "./turnBadge";

const platform = vi.hoisted(() => ({ native: false }));
const background = vi.hoisted(() => vi.fn());
const nativeWindow = vi.hoisted(() => ({
  setBadgeCount: vi.fn(),
  setIcon: vi.fn(),
  onFocusChanged: vi.fn(),
}));
const image = vi.hoisted(() => ({ close: vi.fn() }));
const imageNew = vi.hoisted(() => vi.fn());
const baseRgba = vi.hoisted(() => new Uint8Array(16 * 16 * 4).fill(7));
const defaultIcon = vi.hoisted(() => ({ rgba: vi.fn(), size: vi.fn(), close: vi.fn() }));
const defaultWindowIcon = vi.hoisted(() => vi.fn());
vi.mock("./runtime", () => ({ isTauriRuntime: () => platform.native }));
vi.mock("./taskNotifications", () => ({ isAppInBackground: background }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => nativeWindow }));
vi.mock("@tauri-apps/api/image", () => ({ Image: { new: imageNew } }));
vi.mock("@tauri-apps/api/app", () => ({ defaultWindowIcon }));

const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/140.0";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";

function useUserAgent(value: string) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(value);
}

let context: Record<string, ReturnType<typeof vi.fn> | ((w: number, h: number) => unknown)>;

beforeEach(() => {
  platform.native = true;
  background.mockReset().mockResolvedValue(true);
  nativeWindow.setBadgeCount.mockReset().mockResolvedValue(undefined);
  nativeWindow.setIcon.mockReset().mockResolvedValue(undefined);
  nativeWindow.onFocusChanged.mockReset().mockResolvedValue(() => undefined);
  image.close.mockReset().mockResolvedValue(undefined);
  imageNew.mockReset().mockResolvedValue(image);
  defaultIcon.rgba.mockReset().mockResolvedValue(baseRgba);
  defaultIcon.size.mockReset().mockResolvedValue({ width: 16, height: 16 });
  defaultIcon.close.mockReset().mockResolvedValue(undefined);
  defaultWindowIcon.mockReset().mockResolvedValue(defaultIcon);
  context = {
    beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn(), stroke: vi.fn(), fillText: vi.fn(),
    drawImage: vi.fn(), putImageData: vi.fn(),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
  } as never;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("platform surface", () => {
  it("draws into the window icon on Windows, uses an app badge elsewhere, and nothing outside Tauri", () => {
    useUserAgent(WINDOWS_UA);
    expect(turnBadgeSurface()).toBe("icon");
    useUserAgent(MAC_UA);
    expect(turnBadgeSurface()).toBe("count");
    platform.native = false;
    expect(turnBadgeSurface()).toBe("none");
  });

  it("keeps badge digits legible on a small taskbar icon", () => {
    expect(badgeLabel(1)).toBe("1");
    expect(badgeLabel(9)).toBe("9");
    expect(badgeLabel(10)).toBe("9+");
  });
});

describe("showTurnBadge", () => {
  it("draws the count in the top-right corner of the app icon on Windows", async () => {
    useUserAgent(WINDOWS_UA);
    await showTurnBadge(3);
    const [pixels, width, height] = imageNew.mock.calls[0];
    const size = BADGED_ICON_SIZE;
    expect([pixels.length, width, height]).toEqual([size * size * 4, size, size]);
    expect(context.drawImage).toHaveBeenCalledWith(expect.any(HTMLCanvasElement), 0, 0, size, size);
    const [x, y, radius] = (context.arc as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(x + radius).toBe(size);
    expect(y - radius).toBe(0);
    expect((context.fillText as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("3");
    expect(nativeWindow.setIcon).toHaveBeenCalledWith(image);
    expect(image.close).toHaveBeenCalledTimes(1);
    expect(nativeWindow.setBadgeCount).not.toHaveBeenCalled();
  });

  it("restores the original app icon at zero", async () => {
    useUserAgent(WINDOWS_UA);
    await showTurnBadge(0);
    expect(imageNew).toHaveBeenCalledWith(baseRgba, 16, 16);
    expect(context.arc).not.toHaveBeenCalled();
    expect(nativeWindow.setIcon).toHaveBeenCalledWith(image);
  });

  it("sets and removes the exact app badge count on macOS and Linux", async () => {
    useUserAgent(MAC_UA);
    await showTurnBadge(12);
    await showTurnBadge(0);
    expect(nativeWindow.setBadgeCount.mock.calls).toEqual([[12], [undefined]]);
    expect(nativeWindow.setIcon).not.toHaveBeenCalled();
  });

  it("does nothing in a plain browser", async () => {
    platform.native = false;
    await showTurnBadge(1);
    expect(nativeWindow.setBadgeCount).not.toHaveBeenCalled();
    expect(nativeWindow.setIcon).not.toHaveBeenCalled();
  });
});

describe("createTurnBadge", () => {
  it("counts background turn ends in order and clears once on return", async () => {
    const show = vi.fn().mockResolvedValue(undefined);
    const badge = createTurnBadge(show);
    await badge.recordTurnEnd();
    await badge.recordTurnEnd();
    badge.clear();
    badge.clear();
    await vi.waitFor(() => expect(show.mock.calls).toEqual([[1], [2], [0]]));
  });

  it("ignores turns that end while miniQ is in the foreground or focus is unknown", async () => {
    const show = vi.fn().mockResolvedValue(undefined);
    const badge = createTurnBadge(show);
    background.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("window state unavailable"));
    await badge.recordTurnEnd();
    await badge.recordTurnEnd();
    badge.clear();
    await Promise.resolve();
    expect(show).not.toHaveBeenCalled();
  });

  it("keeps counting after a native badge failure", async () => {
    const show = vi.fn().mockRejectedValueOnce(new Error("OS error")).mockResolvedValue(undefined);
    const badge = createTurnBadge(show);
    await badge.recordTurnEnd();
    await badge.recordTurnEnd();
    await vi.waitFor(() => expect(show.mock.calls).toEqual([[1], [2]]));
  });
});

describe("clearTurnBadgeOnFocus", () => {
  it("clears on document focus and native window focus, and unsubscribes both", async () => {
    let nativeHandler: ((event: { payload: boolean }) => void) | undefined;
    const unlisten = vi.fn();
    nativeWindow.onFocusChanged.mockImplementation(async (handler) => { nativeHandler = handler; return unlisten; });
    const badge = { recordTurnEnd: vi.fn(), clear: vi.fn() };
    const dispose = clearTurnBadgeOnFocus(badge);
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(nativeHandler).toBeDefined());
    nativeHandler!({ payload: false });
    nativeHandler!({ payload: true });
    expect(badge.clear).toHaveBeenCalledTimes(2);
    dispose();
    window.dispatchEvent(new Event("focus"));
    expect(badge.clear).toHaveBeenCalledTimes(2);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes a native listener that registers after disposal", async () => {
    const unlisten = vi.fn();
    nativeWindow.onFocusChanged.mockResolvedValue(unlisten);
    const dispose = clearTurnBadgeOnFocus({ recordTurnEnd: vi.fn(), clear: vi.fn() });
    dispose();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });
});

describe("desktop capability", () => {
  it("grants only the window badge setters the main window needs", () => {
    const capability = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8"));
    expect(capability.windows).toEqual(["main"]);
    expect(capability.permissions).toEqual(expect.arrayContaining([
      "core:default",
      "core:app:allow-default-window-icon",
      "core:window:allow-set-badge-count",
      "core:window:allow-set-icon",
    ]));
    expect(capability.permissions).not.toContain("core:window:allow-set-badge-label");
    expect(capability.permissions).not.toContain("core:window:allow-set-overlay-icon");
  });
});
