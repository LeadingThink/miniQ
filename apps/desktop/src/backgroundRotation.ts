// Wallpaper playlists and automatic rotation, ported from Zaiwen Web
// (web/src/theme/theme-rotation.ts).
// - A playlist is a themed set of backgrounds. "跟随时间" picks by time of day.
// - Rotation switches in order or at random. The timer pauses while the
//   window is hidden, and only one window advances when several are open.
// - "我的合集" is a custom set the user edits from the picker cards.
// State stays in local storage on this device.

import { getActiveBackground, storeBackground } from "./background";
import { BACKGROUNDS, isBackgroundId, NO_BACKGROUND } from "./backgroundCatalog";

export const ROTATION_STORAGE_KEY = "miniq.appearance.rotation";

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
    items: ["14-fishing", "06-summer", "glyph-tokens", "ambient-mesh-dawn", "ambient-bokeh-mint"],
  },
  {
    id: "day",
    name: "白天",
    from: 9,
    items: ["06-summer", "glyph-tokens", "13-court", "14-fishing", "ambient-waves-mint", "ambient-mesh-dawn"],
  },
  {
    id: "dusk",
    name: "黄昏",
    from: 16,
    items: ["13-court", "04-rooftop", "14-fishing", "12-pixelcamp", "ambient-mesh-ember", "ambient-bokeh-gold"],
  },
  {
    id: "evening",
    name: "夜晚",
    from: 19,
    items: [
      "05-rainstore",
      "07-station",
      "03-deskcat",
      "09-nightcar",
      "11-gameroom",
      "ambient-rain-neon",
      "ambient-fireflies-forest",
    ],
  },
  {
    id: "night",
    name: "深夜",
    from: 23,
    items: [
      "01-spacecat",
      "02-spirits",
      "10-space",
      "12-pixelcamp",
      "08-mecha",
      "glyph-globe",
      "ambient-aurora-polar",
      "ambient-stars-violet",
    ],
  },
];

const idsWhere = (test: (item: (typeof BACKGROUNDS)[number]) => boolean) =>
  BACKGROUNDS.filter((item) => item.kind !== "none" && test(item)).map((item) => item.id);

export const PLAYLISTS: readonly PlaylistDefinition[] = [
  { id: "timeline", name: "跟随时间", description: "清晨湖畔、午后窗边、黄昏球场、深夜星空，随一天的时间变换" },
  {
    id: "cozy",
    name: "治愈陪伴",
    description: "猫咪、小精灵与夏日窗边",
    items: ["01-spacecat", "02-spirits", "03-deskcat", "06-summer", "14-fishing"],
  },
  {
    id: "city-night",
    name: "城市夜色",
    description: "天台、雨夜便利店、月下电车与霓虹街道",
    items: ["04-rooftop", "05-rainstore", "07-station", "09-nightcar", "11-gameroom"],
  },
  {
    id: "cosmos",
    name: "星际漫游",
    description: "飞船、机甲与字符星球",
    items: ["10-space", "01-spacecat", "08-mecha", "glyph-globe", "glyph-bytes"],
  },
  {
    id: "outdoor",
    name: "山野时光",
    description: "露营、湖畔、球场与森林",
    items: ["12-pixelcamp", "14-fishing", "13-court", "02-spirits", "06-summer"],
  },
  { id: "people", name: "人物风景", description: "人物与风景的慢镜头", items: idsWhere((item) => item.group === "人物风景") },
  { id: "anime", name: "原创动漫", description: "原创动漫场景动态壁纸", items: idsWhere((item) => item.group === "原创动漫") },
  { id: "future", name: "未来科技", description: "城市、机械与未来科技画面", items: idsWhere((item) => item.group === "未来科技") },
  {
    id: "nature",
    name: "自然四季",
    description: "山川湖海与四季风景",
    items: idsWhere((item) => ["自然风景", "四季风景", "海与岸"].includes(item.group)),
  },
  { id: "glyph", name: "代码诗意", description: "全部字符动效", items: idsWhere((item) => item.kind === "glyph") },
  {
    id: "ambient",
    name: "光影氛围",
    description: "全部光影氛围动效，纯程序绘制、不下载素材",
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
    description: "细雨、落雪、海浪与涟漪，适合长时间专注",
    items: idsWhere((item) => item.kind === "ambient" && ["rain", "snow", "waves", "ripples"].includes(item.style ?? "")),
  },
  { id: "all", name: "全部壁纸", description: "视频壁纸、字符动效与光影氛围全部轮换", items: idsWhere(() => true) },
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
  try {
    return normalizeRotation(JSON.parse(window.localStorage.getItem(ROTATION_STORAGE_KEY) || "null"));
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
    window.localStorage.setItem(ROTATION_STORAGE_KEY, JSON.stringify(state));
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

function onStorage(event: StorageEvent) {
  if (event.storageArea && event.storageArea !== window.localStorage) return;
  if (event.key !== null && event.key !== ROTATION_STORAGE_KEY) return;
  setState(readRotation());
  schedule();
}

/**
 * Call at startup. When a switch is due (for example the next day), or the
 * current background is outside the active time slot, switch now.
 */
export function initializeRotation() {
  setState(readRotation());
  if (!bound) {
    bound = true;
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("storage", onStorage);
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
