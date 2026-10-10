// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { DEFAULT_COMPANION_PREFS, parseCompanionPrefs, readCompanionPrefs, setCompanionMode } from "./companionPrefs";

it("defaults to hidden and validates persisted modes and physical coordinates", () => {
  expect(parseCompanionPrefs(null)).toEqual(DEFAULT_COMPANION_PREFS);
  expect(parseCompanionPrefs({ mode: "brand", position: { x: NaN, y: 1 } })).toEqual(DEFAULT_COMPANION_PREFS);
  expect(parseCompanionPrefs({ mode: "pet", position: { x: -1920, y: 120 } })).toEqual({ mode: "pet", position: { x: -1920, y: 120 } });
  expect(parseCompanionPrefs({ mode: "dots", position: { x: 2.5, y: 2 } })).toEqual({ mode: "dots", position: null });
  expect(parseCompanionPrefs({ mode: "pet", position: { x: 2 ** 40, y: 0 } })).toEqual({ mode: "pet", position: null });
});
it("web defaults are hidden and never silently enable the pet", async () => {
  const read = vi.spyOn(Storage.prototype, "getItem");
  expect(await readCompanionPrefs()).toEqual(DEFAULT_COMPANION_PREFS);
  await expect(setCompanionMode("pet")).rejects.toThrow("桌面应用");
  expect(read).not.toHaveBeenCalled(); read.mockRestore();
});
