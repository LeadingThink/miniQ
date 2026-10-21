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
    expect(resolvePlaylistItems("ambient")).toHaveLength(97);
    expect(resolvePlaylistItems("starlight").length).toBe(36);
    expect(resolvePlaylistItems("calm")).toHaveLength(33);
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
      custom: ["none", "quiet-whale", "quiet-whale", "bogus", ...many, ...many],
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
    expect(state.custom[0]).toBe("quiet-whale");
    expect(state.lastSwitchAt).toBe(0);
  });

  it("reads broken storage safely", () => {
    localStorage.setItem(ROTATION_STORAGE_KEY, "{not json");
    expect(readRotation().enabled).toBe(false);
    localStorage.clear();
  });

  it("picks the next background in order or at random without repeats", () => {
    const items = ["quiet-whale", "quiet-fox", "quiet-clay"];
    expect(pickNextBackground([], "none", "sequence")).toBeNull();
    expect(pickNextBackground(["quiet-whale"], "quiet-whale", "shuffle")).toBe("quiet-whale");
    expect(pickNextBackground(items, "quiet-whale", "sequence")).toBe("quiet-fox");
    expect(pickNextBackground(items, "quiet-clay", "sequence")).toBe("quiet-whale");
    expect(pickNextBackground(items, "none", "sequence")).toBe("quiet-whale");
    for (const value of [0, 0.5, 0.9999]) {
      expect(pickNextBackground(items, "quiet-fox", "shuffle", () => value)).not.toBe("quiet-fox");
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
    expect(activeId()).toBe("quiet-fox");
    vi.advanceTimersByTime(60_000);
    expect(activeId()).toBe("quiet-whale");
    expect(readRotation().lastSwitchAt).toBe(Date.now());
  });

  it("restarts the countdown after a manual pick and stops when disabled", () => {
    updateRotation({ playlistId: "cozy", interval: 1, enabled: true });
    vi.advanceTimersByTime(40_000);
    storeBackground("quiet-clay");
    restartRotationTimer();
    vi.advanceTimersByTime(40_000);
    expect(activeId()).toBe("quiet-clay");
    vi.advanceTimersByTime(21_000);
    expect(activeId()).toBe("quiet-fox");
    updateRotation({ enabled: false });
    vi.advanceTimersByTime(5 * 60_000);
    expect(activeId()).toBe("quiet-fox");
  });

  it("builds a custom playlist and resumes an overdue rotation at startup", () => {
    toggleCustomBackground("quiet-whale");
    toggleCustomBackground("quiet-clay");
    toggleCustomBackground("none");
    expect(getRotation().custom).toEqual(["quiet-whale", "quiet-clay"]);
    toggleCustomBackground("quiet-whale");
    expect(getRotation().custom).toEqual(["quiet-clay"]);
    toggleCustomBackground("quiet-whale");

    localStorage.setItem(
      ROTATION_STORAGE_KEY,
      JSON.stringify({ ...getRotation(), enabled: true, playlistId: "custom", lastSwitchAt: Date.now() - 3_600_000 }),
    );
    storeBackground("quiet-clay");
    initializeRotation();
    expect(resolvePlaylistItems("custom", getRotation().custom)).toEqual(["quiet-clay", "quiet-whale"]);
    expect(activeId()).toBe("quiet-whale");
  });

  it("advances manually even when rotation is off", () => {
    updateRotation({ playlistId: "ambient" });
    expect(advanceRotation()).toMatch(/^ambient-/);
    expect(activeId()).toMatch(/^ambient-/);
  });
});
