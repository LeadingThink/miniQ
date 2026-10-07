// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openMobileUpdateUrl } from "./mobileUpdateLinks";
import { MOBILE_DOWNLOAD_PAGE_URL } from "./mobileUpdate";
const { native, assign, external } = vi.hoisted(() => ({ native: vi.fn(), assign: vi.fn(), external: vi.fn() }));
vi.mock("./mobileUpdate", async (original) => ({ ...await original<typeof import("./mobileUpdate")>(), isMobileUpdateSupported: native }));
vi.mock("./externalLinks", () => ({ openExternalUrl: external }));
const apk = "https://oss.zaiwen.top/releases/miniq/android/v0.1.48/miniQ.apk";
beforeEach(() => { vi.resetAllMocks(); native.mockReturnValue(true); vi.stubGlobal("window", { location: { assign } }); });
afterEach(() => vi.unstubAllGlobals());
it.each([apk, MOBILE_DOWNLOAD_PAGE_URL])("uses Capacitor external navigation for %s", async (url) => {
  await openMobileUpdateUrl(url);
  expect(assign).toHaveBeenCalledWith(url); expect(external).not.toHaveBeenCalled();
});
it("keeps existing external opener for non-Android contexts", async () => {
  native.mockReturnValue(false); await openMobileUpdateUrl(apk);
  expect(external).toHaveBeenCalledWith(apk); expect(assign).not.toHaveBeenCalled();
});
it.each(["javascript:alert(1)", "https://evil.example/app.apk", apk + "?redirect=1"])("rejects unsafe destination %s", async (url) => {
  await expect(openMobileUpdateUrl(url)).rejects.toThrow("下载地址无效");
  expect(assign).not.toHaveBeenCalled(); expect(external).not.toHaveBeenCalled();
});
it("propagates navigation failures for visible UI recovery", async () => {
  assign.mockImplementation(() => { throw new Error("navigation failed"); });
  await expect(openMobileUpdateUrl(apk)).rejects.toThrow("navigation failed");
});
