import { beforeEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ platform: "ios", available: true, native: true,
  update: vi.fn(), getState: vi.fn(), reload: vi.fn(), goBack: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: {
  getPlatform: () => native.platform, isNativePlatform: () => native.native,
  isPluginAvailable: () => native.available,
}, registerPlugin: () => native }));
import { mobileZaiwenCapabilities, updateMobileZaiwen, reloadMobileZaiwen } from "./mobileZaiwen";

const state = { loading: false, canGoBack: false, error: null };
const bounds = { x: 0, y: 64, width: 390, height: 720, viewportWidth: 390 };
beforeEach(() => {
  vi.resetAllMocks(); native.platform = "ios"; native.available = true; native.native = true;
  native.update.mockResolvedValue(state); native.reload.mockResolvedValue(state);
});

it.each(["ios", "android"])("advertises only implemented native site capabilities on %s", async (platform) => {
  native.platform = platform;
  expect(mobileZaiwenCapabilities()).toEqual({ embeddedView: true, persistentSession: true,
    navigation: true, domAutomation: false, screenshot: false, syntheticInput: false, ssoKeySelection: false });
  await updateMobileZaiwen({ ...bounds, visible: true });
  expect(native.update).toHaveBeenCalledWith({ ...bounds, visible: true });
});

it.each(["web", "windows", "linux"])("does not invoke a mobile plugin on %s", async (platform) => {
  native.platform = platform;
  expect(mobileZaiwenCapabilities().embeddedView).toBe(false);
  await expect(updateMobileZaiwen({ ...bounds, visible: true })).rejects.toThrow("原生手机版");
  expect(native.update).not.toHaveBeenCalled();
});

it("reports older native builds without the plugin as unsupported", () => {
  native.available = false;
  expect(mobileZaiwenCapabilities().embeddedView).toBe(false);
});

it("serializes a late open before hiding so switching back cannot leave an overlay", async () => {
  let finish!: (value: typeof state) => void;
  native.update.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const open = updateMobileZaiwen({ ...bounds, visible: true });
  const hide = updateMobileZaiwen({ visible: false });
  await vi.waitFor(() => expect(native.update).toHaveBeenCalledOnce());
  finish(state); await Promise.all([open, hide]);
  expect(native.update).toHaveBeenLastCalledWith({ visible: false });
});

it("allows retry after a failed native command", async () => {
  native.update.mockRejectedValueOnce(new Error("not ready"));
  await expect(updateMobileZaiwen({ ...bounds, visible: true })).rejects.toThrow();
  await expect(reloadMobileZaiwen()).resolves.toEqual(state);
});
