// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("./runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("./mobileRuntime", () => ({ isNativeMobileApp: () => false }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { playTaskSound, setTaskSoundSettings } from "./taskSounds";

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  invoke.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());
it("previews on macOS without creating or unlocking a browser AudioContext", async () => {
  expect(await playTaskSound("completed", { userInitiated: true, ignoreSettings: true })).toBe(true);
  expect(invoke).toHaveBeenCalledWith("play_task_sound", { kind: "completed", volume: 0.55 });
});
it("uses the same native path for real foreground task sounds and respects settings", async () => {
  expect(await playTaskSound("failed", { dedupeKey: "native-real" })).toBe(true);
  expect(await playTaskSound("failed", { dedupeKey: "native-real" })).toBe(false);
  setTaskSoundSettings({ backgroundOnly: true });
  expect(await playTaskSound("completed")).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(1);
});
it("reports playback failure and allows retry without consuming the event key", async () => {
  invoke.mockRejectedValueOnce(new Error("audio device unavailable"));
  expect(await playTaskSound("attention", { dedupeKey: "native-retry" })).toBe(false);
  expect(await playTaskSound("attention", { dedupeKey: "native-retry" })).toBe(true);
  expect(invoke).toHaveBeenCalledTimes(2);
});
