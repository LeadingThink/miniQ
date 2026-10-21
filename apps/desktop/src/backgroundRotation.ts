import { isNativeMobileApp } from "./mobileRuntime";
// Wallpaper playlists and automatic rotation, ported from Zaiwen Web
// (web/src/theme/theme-rotation.ts).
// - A playlist is a themed set of backgrounds. "跟随时间" picks by time of day.
// - Rotation switches in order or at random. The timer pauses while the
//   window is hidden, and only one window advances when several are open.
// - "我的合集" is a custom set the user edits from the picker cards.
// State stays in local storage on this device.

import { getActiveBackground, storeBackground } from "./background";
import { BACKGROUNDS, isBackgroundId, NO_BACKGROUND } from "./backgroundCatalog";

import { ROTATION_STORAGE_KEY, WALLPAPER_CHANGE_EVENT, localAppearanceStorage, readAppearanceValue, writeAppearanceValue, migrateWallpaperPreferences, notifyWallpaperChange } from "./appearanceStorage";
export { ROTATION_STORAGE_KEY } from "./appearanceStorage";

export type RotationOrder = "sequence" | "shuffle";
export type PlaylistId =
  | "timeline"
  | "cozy"
  | "city-night"
  | "cosmos"
  | "outdoor"
  | "people"
  | "anime"
  | "future"
  | "nature"
  | "glyph"
  | "ambient"
  | "starlight"
  | "calm"
  | "all"
  | "custom";

export interface TimeSlot {
  id: string;
  name: string;
  /** First hour (inclusive). The slot lasts until the next slot starts. */
  from: number;
  items: readonly string[];
}

export interface PlaylistDefinition {
  id: PlaylistId;
  name: string;
  description: string;
  /** Static list. "timeline" and "custom" resolve at run time. */
  items?: readonly string[];
}

export interface RotationState {
  enabled: boolean;
  playlistId: PlaylistId;
  /** Minutes between switches. */
  interval: number;
  order: RotationOrder;
  custom: string[];
  /** Last switch time in ms. Keeps the timer across reloads and windows. */
  lastSwitchAt: number;
}

export const ROTATION_INTERVALS = [1, 3, 5, 10, 30, 60] as const;
export const CUSTOM_LIMIT = 24;

export const TIME_SLOTS: readonly TimeSlot[] = [
  {
    id: "dawn",
    name: "清晨",
    from: 5,
    items: ["quiet-greenhouse", "quiet-desert", "ambient-bokeh-gold", "ambient-ripples-silver"],
  },
  {
    id: "day",
    name: "白天",
    from: 9,
    items: ["quiet-clay", "quiet-greenhouse", "ambient-bokeh-forest", "ambient-waves-ocean"],
  },
  {
    id: "dusk",
    name: "黄昏",
    from: 16,
    items: ["quiet-desert", "quiet-anime-sky", "quiet-shore", "ambient-aurora-violet", "ambient-bokeh-sakura"],
  },
  {
    id: "evening",
    name: "夜晚",
    from: 19,
    items: [
      "quiet-shore",
      "quiet-fox",
      "quiet-anime-sky",
      "ambient-ripples-ocean",
      "ambient-fireflies-forest",
    ],
  },
  {
    id: "night",
    name: "深夜",
    from: 23,
    items: [
      "quiet-moonwater",
      "quiet-whale",
      "quiet-fox",
      "ambient-aurora-polar",
      "ambient-stars-violet",
      "ambient-snow-silver",
    ],
  },
];

const idsWhere = (test: (item: (typeof BACKGROUNDS)[number]) => boolean) =>
  BACKGROUNDS.filter((item) => item.kind !== "none" && test(item)).map((item) => item.id);

export const PLAYLISTS: readonly PlaylistDefinition[] = [
  { id: "timeline", name: "跟随时间", description: "清晨植物、白天暖光、黄昏旅人、深夜星空，随时间变换" },
  {
    id: "cozy",
    name: "治愈陪伴",
    description: "动物、植物与柔和的立体光线",
    items: ["quiet-fox", "quiet-whale", "quiet-greenhouse", "quiet-clay"],
  },
  {
    id: "city-night",
    name: "静谧夜色",
    description: "雾岸、月汐与深海的低亮度动效",
    items: ["quiet-shore", "quiet-moonwater", "quiet-whale", "ambient-ripples-ocean"],
  },
  {
    id: "cosmos",
    name: "空间与光",
    description: "深海、星光与极简 3D 光影",
    items: ["quiet-whale", "quiet-clay", "ambient-stars-polar", "ambient-aurora-violet"],
  },
  {
    id: "outdoor",
    name: "山野时光",
    description: "沙地、自然水面与植物光影",
    items: ["quiet-desert", "quiet-greenhouse", "quiet-moonwater", "ambient-waves-forest"],
  },
  { id: "people", name: "人物风景", description: "人物与风景的慢镜头", items: idsWhere((item) => item.group === "人物风景") },
  { id: "anime", name: "原创动漫", description: "原创动漫场景动态壁纸", items: idsWhere((item) => item.group === "原创动漫") },
  { id: "future", name: "极简立体", description: "低干扰的 3D 构成和抽象光影", items: idsWhere((item) => ["立体构成", "抽象科技"].includes(item.group)) },
  {
    id: "nature",
    name: "自然四季",
    description: "水面、雾气、动物与植物",
    items: idsWhere((item) => ["自然风景", "动物伙伴", "室内植物"].includes(item.group)),
  },
  {
    id: "ambient",
    name: "光影氛围",
    description: "低饱和程序光影，不下载素材",
    items: idsWhere((item) => item.kind === "ambient"),
  },
  {
    id: "starlight",
    name: "星河夜空",
    description: "极光、星空、星座与萤火",
    items: idsWhere(
      (item) =>
        item.kind === "ambient" &&
        !item.light &&
        ["aurora", "stars", "constellation", "fireflies"].includes(item.style ?? ""),
    ),
  },
  {
    id: "calm",
    name: "静心专注",
    description: "落雪、海浪与涟漪，适合长时间专注",
    items: idsWhere((item) => item.kind === "ambient" && ["snow", "waves", "ripples"].includes(item.style ?? "")),
  },
  { id: "glyph", name: "代码诗意", description: "稀疏字符与缓慢光影", items: idsWhere((item) => item.kind === "glyph") },
  { id: "all", name: "全部壁纸", description: "精选视频和低干扰光影全部轮换", items: idsWhere(() => true) },
  { id: "custom", name: "我的合集", description: "在壁纸卡片上点「+」自由组合" },
];

const playlistIds = new Set<string>(PLAYLISTS.map((item) => item.id));
const isPlayable = (id: unknown): id is string => isBackgroundId(id) && id !== NO_BACKGROUND;

export const DEFAULT_ROTATION: Readonly<RotationState> = Object.freeze({
  enabled: false,
  playlistId: "timeline",
  interval: 5,
  order: "sequence",
  custom: [],
  lastSwitchAt: 0,
});

export function normalizeRotation(value: unknown): RotationState {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const custom = Array.isArray(raw.custom) ? [...new Set(raw.custom.filter(isPlayable))].slice(0, CUSTOM_LIMIT) : [];
  const interval = Number(raw.interval);
  const lastSwitchAt = Number(raw.lastSwitchAt);
  return {
    enabled: raw.enabled === true,
    playlistId:
      typeof raw.playlistId === "string" && playlistIds.has(raw.playlistId)
        ? (raw.playlistId as PlaylistId)
        : DEFAULT_ROTATION.playlistId,
    interval: (ROTATION_INTERVALS as readonly number[]).includes(interval) ? interval : DEFAULT_ROTATION.interval,
    order: raw.order === "shuffle" ? "shuffle" : "sequence",
    custom,
    lastSwitchAt: Number.isFinite(lastSwitchAt) && lastSwitchAt > 0 ? lastSwitchAt : 0,
  };
}

export function readRotation(): RotationState {
  migrateWallpaperPreferences();
  try {
    return normalizeRotation(JSON.parse(readAppearanceValue(localAppearanceStorage(), ROTATION_STORAGE_KEY) || "null"));
  } catch {
    return normalizeRotation(null);
  }
}

export function resolveTimeSlot(date: Date = new Date()): TimeSlot {
  const hour = date.getHours();
  // Slots are sorted by start hour. Hours before the first slot belong to the last one.
  let slot = TIME_SLOTS[TIME_SLOTS.length - 1]!;
  for (const item of TIME_SLOTS) {
    if (hour >= item.from) slot = item;
  }
  return slot;
}

export function resolvePlaylistItems(
  playlistId: PlaylistId,
  custom: readonly string[] = [],
  date: Date = new Date(),
): string[] {
  if (playlistId === "timeline") return [...resolveTimeSlot(date).items];
  if (playlistId === "custom") return custom.filter(isPlayable);
  return [...(PLAYLISTS.find((item) => item.id === playlistId)?.items ?? [])];
}

/** In order: the item after the current one. Shuffle: any item except the current one. */
export function pickNextBackground(
  items: readonly string[],
  current: string,
  order: RotationOrder,
  random: () => number = Math.random,
): string | null {
  if (!items.length) return null;
  if (items.length === 1) return items[0]!;
  const index = items.indexOf(current);
  if (order === "sequence") return items[(index + 1) % items.length]!;
  const candidates = items.filter((id) => id !== current);
  return candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]!;
}

/* ---------------- Runtime controller ---------------- */

let state: RotationState = normalizeRotation(null);
let timer: number | undefined;
let bound = false;
const listeners = new Set<() => void>();

function setState(next: RotationState) {
  state = next;
  listeners.forEach((listener) => listener());
}

function persist() {
  try {
    writeAppearanceValue(localAppearanceStorage(), ROTATION_STORAGE_KEY, JSON.stringify(state));
    notifyWallpaperChange(undefined, [ROTATION_STORAGE_KEY]);
  } catch {
    // Without storage the setting applies to this window only.
  }
}

const intervalMs = () => state.interval * 60_000;

export function getRotation(): RotationState {
  return state;
}

export function subscribeRotation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Switch to the next background in the playlist now. */
export function advanceRotation(now = Date.now()): string | null {
  if (isNativeMobileApp()) return null;
  const items = resolvePlaylistItems(state.playlistId, state.custom, new Date(now));
  const next = pickNextBackground(items, getActiveBackground().id, state.order);
  setState({ ...state, lastSwitchAt: now });
  persist();
  if (next) storeBackground(next);
  schedule();
  return next;
}

function tick() {
  timer = undefined;
  if (!state.enabled || document.hidden) return;
  // Another window may have advanced already: trust the stored time.
  const stored = readRotation();
  if (stored.lastSwitchAt > state.lastSwitchAt) setState({ ...state, lastSwitchAt: stored.lastSwitchAt });
  if (Date.now() - state.lastSwitchAt >= intervalMs() - 500) advanceRotation();
  else schedule();
}

function schedule() {
  if (isNativeMobileApp()) return;
  window.clearTimeout(timer);
  timer = undefined;
  if (!state.enabled || document.hidden) return;
  const remaining = Math.max(1_000, state.lastSwitchAt + intervalMs() - Date.now());
  timer = window.setTimeout(tick, remaining);
}

function onVisibility() {
  if (document.hidden) {
    window.clearTimeout(timer);
    timer = undefined;
  } else {
    schedule();
  }
}

function onStorage(event: Event) {
  if (event instanceof CustomEvent && !event.detail.includes(ROTATION_STORAGE_KEY)) return;
  if (event instanceof StorageEvent) {
    if (event.storageArea && event.storageArea !== localAppearanceStorage()) return;
    if (event.key !== null && event.key !== ROTATION_STORAGE_KEY) return;
  }
  setState(readRotation());
  schedule();
}

/**
 * Call at startup. When a switch is due (for example the next day), or the
 * current background is outside the active time slot, switch now.
 */
export function initializeRotation() {
  if (isNativeMobileApp()) return;
  setState(readRotation());
  if (!bound) {
    bound = true;
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("storage", onStorage);
    window.addEventListener(WALLPAPER_CHANGE_EVENT, onStorage);
  }
  if (!state.enabled) return;
  const items = resolvePlaylistItems(state.playlistId, state.custom);
  const due = Date.now() - state.lastSwitchAt >= intervalMs();
  if (due || (items.length && !items.includes(getActiveBackground().id))) advanceRotation();
  else schedule();
}

export function updateRotation(patch: Partial<Omit<RotationState, "lastSwitchAt">>) {
  const prev = state;
  const next = normalizeRotation({ ...prev, ...patch });
  const turnedOn = next.enabled && !prev.enabled;
  const playlistChanged = next.playlistId !== prev.playlistId;
  setState(next);
  if (next.enabled && (turnedOn || playlistChanged)) {
    // Show a background from the playlist at once as feedback.
    advanceRotation();
    return;
  }
  persist();
  schedule();
}

/** A manual pick restarts the timer from that background. */
export function restartRotationTimer() {
  if (!state.enabled) return;
  setState({ ...state, lastSwitchAt: Date.now() });
  persist();
  schedule();
}

export function toggleCustomBackground(id: string) {
  if (!isPlayable(id)) return;
  const custom = [...state.custom];
  const index = custom.indexOf(id);
  if (index >= 0) custom.splice(index, 1);
  else if (custom.length < CUSTOM_LIMIT) custom.push(id);
  updateRotation({ custom });
}

/** Test only: reset runtime state. */
export function resetRotationForTest() {
  window.clearTimeout(timer);
  timer = undefined;
  state = normalizeRotation(null);
  listeners.clear();
}
