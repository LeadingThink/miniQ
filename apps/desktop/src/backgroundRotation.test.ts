// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getActiveBackground, initializeBackground, storeBackground } from "./background";
import { BACKGROUNDS, isBackgroundId } from "./backgroundCatalog";
import {
  advanceRotation,
  getRotation,
  initializeRotation,
  normalizeRotation,
  pickNextBackground,
  PLAYLISTS,
  readRotation,
  resetRotationForTest,
  resolvePlaylistItems,
  resolveTimeSlot,
  restartRotationTimer,
  ROTATION_STORAGE_KEY,
  TIME_SLOTS,
  toggleCustomBackground,
  updateRotation,
} from "./backgroundRotation";

const at = (hour: number) => new Date(2026, 0, 1, hour, 30);
const activeId = () => getActiveBackground().id;

describe("rotation helpers", () => {
  it("only references real, playable backgrounds", () => {
    for (const playlist of PLAYLISTS) {
      for (const id of playlist.items ?? []) {
        expect(isBackgroundId(id), `${playlist.id}:${id}`).toBe(true);
        expect(id).not.toBe("none");
      }
      if (playlist.items) expect(playlist.items.length, playlist.id).toBeGreaterThan(0);
    }
    for (const slot of TIME_SLOTS) {
      expect(slot.items.length).toBeGreaterThan(0);
      for (const id of slot.items) expect(isBackgroundId(id), `${slot.id}:${id}`).toBe(true);
    }
    expect(resolvePlaylistItems("all")).toHaveLength(BACKGROUNDS.length - 1);
    expect(resolvePlaylistItems("ambient")).toHaveLength(110);
    expect(resolvePlaylistItems("starlight").length).toBeGreaterThan(20);
    expect(resolvePlaylistItems("calm")).toHaveLength(44);
  });

  it("maps hours to time slots and folds small hours into night", () => {
    expect(resolveTimeSlot(at(2)).id).toBe("night");
    expect(resolveTimeSlot(at(5)).id).toBe("dawn");
    expect(resolveTimeSlot(at(12)).id).toBe("day");
    expect(resolveTimeSlot(at(17)).id).toBe("dusk");
    expect(resolveTimeSlot(at(20)).id).toBe("evening");
    expect(resolveTimeSlot(at(23)).id).toBe("night");
    expect(resolvePlaylistItems("timeline", [], at(20))).toEqual([...resolveTimeSlot(at(20)).items]);
  });

  it("normalizes untrusted stored state", () => {
    const many = BACKGROUNDS.map((item) => item.id);
    const state = normalizeRotation({
      enabled: "yes",
      playlistId: "hack",
      interval: 7,
      order: "reverse",
      custom: ["none", "01-spacecat", "01-spacecat", "bogus", ...many, ...many],
      lastSwitchAt: -5,
    });
    expect(state.enabled).toBe(false);
    expect(state.playlistId).toBe("timeline");
    expect(state.interval).toBe(5);
    expect(state.order).toBe("sequence");
    expect(state.custom).not.toContain("none");
    expect(state.custom).not.toContain("bogus");
    expect(new Set(state.custom).size).toBe(state.custom.length);
    expect(state.custom).toHaveLength(24);
    expect(state.custom[0]).toBe("01-spacecat");
    expect(state.lastSwitchAt).toBe(0);
  });

  it("reads broken storage safely", () => {
    localStorage.setItem(ROTATION_STORAGE_KEY, "{not json");
    expect(readRotation().enabled).toBe(false);
    localStorage.clear();
  });

  it("picks the next background in order or at random without repeats", () => {
    const items = ["01-spacecat", "02-spirits", "03-deskcat"];
    expect(pickNextBackground([], "none", "sequence")).toBeNull();
    expect(pickNextBackground(["01-spacecat"], "01-spacecat", "shuffle")).toBe("01-spacecat");
    expect(pickNextBackground(items, "01-spacecat", "sequence")).toBe("02-spirits");
    expect(pickNextBackground(items, "03-deskcat", "sequence")).toBe("01-spacecat");
    expect(pickNextBackground(items, "none", "sequence")).toBe("01-spacecat");
    for (const value of [0, 0.5, 0.9999]) {
      expect(pickNextBackground(items, "02-spirits", "shuffle", () => value)).not.toBe("02-spirits");
    }
  });
});

describe("rotation runtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0));
    localStorage.clear();
    initializeBackground();
    resetRotationForTest();
  });
  afterEach(() => {
    resetRotationForTest();
    vi.useRealTimers();
  });

  it("switches at once when enabled and then on every interval", () => {
    updateRotation({ playlistId: "cozy", interval: 1 });
    expect(activeId()).toBe("none");
    updateRotation({ enabled: true });
    expect(activeId()).toBe("01-spacecat");
    vi.advanceTimersByTime(60_000);
    expect(activeId()).toBe("02-spirits");
    expect(readRotation().lastSwitchAt).toBe(Date.now());
  });

  it("restarts the countdown after a manual pick and stops when disabled", () => {
    updateRotation({ playlistId: "cozy", interval: 1, enabled: true });
    vi.advanceTimersByTime(40_000);
    storeBackground("03-deskcat");
    restartRotationTimer();
    vi.advanceTimersByTime(40_000);
    expect(activeId()).toBe("03-deskcat");
    vi.advanceTimersByTime(21_000);
    expect(activeId()).toBe("06-summer");
    updateRotation({ enabled: false });
    vi.advanceTimersByTime(5 * 60_000);
    expect(activeId()).toBe("06-summer");
  });

  it("builds a custom playlist and resumes an overdue rotation at startup", () => {
    toggleCustomBackground("10-space");
    toggleCustomBackground("glyph-tokens");
    toggleCustomBackground("none");
    expect(getRotation().custom).toEqual(["10-space", "glyph-tokens"]);
    toggleCustomBackground("10-space");
    expect(getRotation().custom).toEqual(["glyph-tokens"]);
    toggleCustomBackground("10-space");

    localStorage.setItem(
      ROTATION_STORAGE_KEY,
      JSON.stringify({ ...getRotation(), enabled: true, playlistId: "custom", lastSwitchAt: Date.now() - 3_600_000 }),
    );
    storeBackground("glyph-tokens");
    initializeRotation();
    expect(resolvePlaylistItems("custom", getRotation().custom)).toEqual(["glyph-tokens", "10-space"]);
    expect(activeId()).toBe("10-space");
  });

  it("advances manually even when rotation is off", () => {
    updateRotation({ playlistId: "glyph" });
    expect(advanceRotation()).toMatch(/^glyph-/);
    expect(activeId()).toMatch(/^glyph-/);
  });
});
