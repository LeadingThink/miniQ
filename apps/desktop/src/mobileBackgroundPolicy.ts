import { getState as getMobilePowerState } from "./mobilePower";
import { createPersistentMobileVideoCache } from "./mobileVideoCache";
import { App } from "@capacitor/app";
import { Device } from "@capacitor/device";
import { Network } from "@capacitor/network";
import { Capacitor } from "@capacitor/core";
import { getBackground, isBackgroundId, NO_BACKGROUND, type BackgroundDefinition } from "./backgroundCatalog";
import { pickNextBackground, resolvePlaylistItems, type RotationState, normalizeRotation } from "./backgroundRotation";
import { BACKGROUND_STORAGE_KEY, ROTATION_STORAGE_KEY, WALLPAPER_CHANGE_EVENT, localAppearanceStorage, readAppearanceValue, writeAppearanceValue, migrateWallpaperPreferences, notifyWallpaperChange } from "./appearanceStorage";

export const MOBILE_BACKGROUND_KEYS = {
  background: "miniq.mobile.appearance.background",
  rotation: "miniq.mobile.appearance.rotation",
  motion: "miniq.mobile.appearance.motion",
  network: "miniq.mobile.appearance.network",
  chargingOnly: "miniq.mobile.appearance.chargingOnly",
  favorites: "miniq.mobile.appearance.favorites",
} as const;

/** Legacy preference values are accepted on input and normalized on read/write. */
export type MobileMotion = "standard" | "low-power" | "system";
export type MobileNetwork = "wifi-only" | "cellular-opt-in";
export type MobileNetworkType = "wifi" | "cellular" | "none" | "unknown";
export type MobileLifecycle = "foreground" | "background" | "unknown";
export type MobileBattery = "charging" | "not-charging" | "unknown";

export interface MobilePreferences { background: string; rotation: RotationState; motion: MobileMotion; network: MobileNetwork; chargingOnly: boolean; favorites: string[] }
export interface MobileConditions { lifecycle: MobileLifecycle; network: MobileNetworkType; battery: MobileBattery; batteryLevel: number | null; lowPower: boolean | null }
export interface MobilePolicySnapshot {
  preferences: MobilePreferences; conditions: MobileConditions; isNative: boolean;
  /** Whether the latest native OS power read returned a known state. */
  osLowPowerModeSupported: boolean;
  reducedMotion: boolean; canAnimate: boolean; canPlayVideo: boolean; canDownloadVideo: boolean;
}

export type VideoDownloadStatus = "idle" | "downloading" | "cached" | "error";
export interface VideoStatus { status: VideoDownloadStatus; bytes?: number; error?: string }

export interface NetworkPlugin {
  getStatus(): Promise<{ connected?: boolean; connectionType?: string }>;
  addListener?(event: "networkStatusChange", listener: (status: { connected?: boolean; connectionType?: string }) => void): Promise<{ remove: () => Promise<void> | void }>;
}
export interface BatteryLike extends EventTarget { charging: boolean; level: number }
interface BatteryNavigator extends Navigator { getBattery?: () => Promise<BatteryLike> }
interface DevicePlugin { getBatteryInfo(): Promise<{ batteryLevel?: number; isCharging?: boolean }> }

export interface MobileCacheStatus { items: number; bytes: number; maxEntries: number; maxBytes: number }
export interface MobileVideoCache {
  getStatus(): MobileCacheStatus;
  /** Refreshes the persisted cache snapshot used by getStatus and peek. */
  stats?(): Promise<{ entries: number; bytes: number }>;
  peek(url: string): Blob | undefined;
  maxEntries: number; maxBytes: number;
  get(url: string): Promise<Blob | undefined>; put(url: string, blob: Blob): Promise<void>;
  remove(url: string): Promise<void>; clear(): Promise<void>;
}
export interface MobileBackgroundPolicyOptions {
  isNative?: () => boolean; storage?: Storage;
  app?: Pick<typeof App, "addListener"> & Partial<Pick<typeof App, "getState">>; network?: NetworkPlugin;
  power?: typeof getMobilePowerState;
  device?: DevicePlugin; battery?: () => Promise<BatteryLike>; now?: () => number;
  cache?: MobileVideoCache; downloadTimeoutMs?: number;
}

const DEFAULT_CACHE_LIMIT = { maxEntries: 3, maxBytes: 24 * 1024 * 1024 };
export function createMemoryVideoCache(limits = DEFAULT_CACHE_LIMIT): MobileVideoCache {
  const entries = new Map<string, { blob: Blob; savedAt: number }>();
  const evict = () => {
    let total = [...entries.values()].reduce((sum, item) => sum + item.blob.size, 0);
    for (const [key, item] of [...entries].sort((a, b) => a[1].savedAt - b[1].savedAt)) {
      if (entries.size <= limits.maxEntries && total <= limits.maxBytes) break;
      entries.delete(key); total -= item.blob.size;
    }
  };
  return {
    ...limits,
    getStatus: () => ({ ...limits, items: entries.size, bytes: [...entries.values()].reduce((sum, entry) => sum + entry.blob.size, 0) }),
    peek: (url) => entries.get(url)?.blob,
    async get(url) { return entries.get(url)?.blob; },
    async put(url, blob) { entries.set(url, { blob, savedAt: Date.now() }); evict(); },
    async remove(url) { entries.delete(url); },
    async clear() { entries.clear(); },
  };
}

const read = readAppearanceValue;
const write = writeAppearanceValue;
export const DEFAULT_MOBILE_PREFERENCES: MobilePreferences = { background: NO_BACKGROUND, rotation: normalizeRotation(null), motion: "standard", network: "cellular-opt-in", chargingOnly: false, favorites: [] };

const normalizeFavorites = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && isBackgroundId(id)))] : [];

export function readMobilePreferences(storage: Storage | undefined = localAppearanceStorage(), mobile = Capacitor.isNativePlatform()): MobilePreferences {
  migrateWallpaperPreferences(storage, mobile);
  let rotation: unknown;
  try { rotation = JSON.parse(read(storage, ROTATION_STORAGE_KEY) ?? "null"); } catch { rotation = null; }
  let favorites: unknown;
  try { favorites = JSON.parse(read(storage, MOBILE_BACKGROUND_KEYS.favorites) ?? "[]"); } catch { favorites = []; }
  const background = read(storage, BACKGROUND_STORAGE_KEY);
  return {
    chargingOnly: false,
    favorites: normalizeFavorites(favorites),
    background: isBackgroundId(background) ? background : NO_BACKGROUND,
    rotation: normalizeRotation(rotation),
    motion: "standard",
    network: "cellular-opt-in",
  };
}
export function writeMobilePreferences(patch: Partial<MobilePreferences>, storage: Storage | undefined = localAppearanceStorage()): MobilePreferences {
  const next = { ...readMobilePreferences(storage), ...patch };
  next.background = isBackgroundId(next.background) ? next.background : NO_BACKGROUND;
  next.rotation = normalizeRotation(next.rotation);
  next.motion = "standard";
  next.network = "cellular-opt-in";
  next.chargingOnly = false;
  next.favorites = normalizeFavorites(next.favorites);
  write(storage, MOBILE_BACKGROUND_KEYS.chargingOnly, JSON.stringify(next.chargingOnly));
  write(storage, MOBILE_BACKGROUND_KEYS.favorites, JSON.stringify(next.favorites));
  write(storage, BACKGROUND_STORAGE_KEY, next.background);
  write(storage, ROTATION_STORAGE_KEY, JSON.stringify(next.rotation));
  write(storage, MOBILE_BACKGROUND_KEYS.motion, next.motion); write(storage, MOBILE_BACKGROUND_KEYS.network, next.network);
  notifyWallpaperChange(storage);
  return next;
}

function connectionType(value: string | undefined): MobileNetworkType {
  if (value === "wifi" || value === "wifi-direct") return "wifi";
  if (value === "cellular") return "cellular";
  if (value === "none") return "none";
  return "unknown";
}

const batteryLevel = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;

let initializationRefs = 0;
let initializationStop: (() => void) | undefined;

export class MobileBackgroundPolicy {
  private preferences: MobilePreferences;
  private conditions: MobileConditions = { lifecycle: "unknown", network: "unknown", battery: "unknown", batteryLevel: null, lowPower: null };
  private readonly options: MobileBackgroundPolicyOptions & { isNative: () => boolean; now: () => number };
  private readonly listeners = new Set<() => void>();
  private readonly cleanups: Array<() => void> = [];
  private readonly statuses = new Map<string, VideoStatus>();
  private readonly downloads = new Map<string, { promise: Promise<Blob>; controller: AbortController; generation: number; needsNetwork: boolean }>();
  private downloadGeneration = 0;
  private cacheQueue: Promise<unknown> = Promise.resolve();
  private started = false;
  private startGeneration = 0;
  private rotationTimer: ReturnType<typeof setTimeout> | undefined;
  private snapshot?: MobilePolicySnapshot;

  constructor(options: MobileBackgroundPolicyOptions = {}) {
    const defaultCache = options.cache ?? (Capacitor.isNativePlatform() ? createPersistentMobileVideoCache() : createMemoryVideoCache());
    this.options = { isNative: () => Capacitor.isNativePlatform(), now: Date.now, ...options, cache: defaultCache };
    this.preferences = readMobilePreferences(options.storage, this.options.isNative());
  }
  getSnapshot(): MobilePolicySnapshot {
    if (this.snapshot) return this.snapshot;
    const reducedMotion = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const foreground = this.conditions.lifecycle === "foreground";
    const canAnimate = foreground;
    const canPlayVideo = foreground;
    const canDownloadVideo = foreground && this.conditions.network !== "none";
    this.snapshot = { preferences: this.preferences, conditions: this.conditions, isNative: this.options.isNative(), osLowPowerModeSupported: this.conditions.lowPower !== null, reducedMotion, canAnimate, canPlayVideo, canDownloadVideo };
    return this.snapshot;
  }
  private refreshPreferences() {
    const next = readMobilePreferences(this.options.storage, this.options.isNative());
    if (JSON.stringify(next) === JSON.stringify(this.preferences)) return;
    this.preferences = next; this.notify(); this.scheduleRotation();
  }
  getRevision(): number { return this.revision; }
  private revision = 0;
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify() { this.snapshot = undefined; this.revision++; this.listeners.forEach((listener) => listener()); }
  private setConditions(patch: Partial<MobileConditions>) {
    this.conditions = { ...this.conditions, ...patch }; this.snapshot = undefined;
    const snapshot = this.getSnapshot();
    if (!snapshot.canPlayVideo) this.cancelDownloads();
    else if (!snapshot.canDownloadVideo) this.cancelDownloads(true);
    this.notify(); this.scheduleRotation();
  }
  private addCleanup(cleanup: () => void, generation: number, removeIfStale?: () => void) {
    if (!this.started || generation !== this.startGeneration) { removeIfStale?.(); return; }
    this.cleanups.push(cleanup);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.refreshPreferences();
    if (typeof window !== "undefined" && (!this.options.storage || this.options.storage === localAppearanceStorage())) {
      const sync = (event: Event) => {
        if (event instanceof StorageEvent && event.storageArea && event.storageArea !== localAppearanceStorage()) return;
        this.refreshPreferences();
      };
      window.addEventListener("storage", sync);
      window.addEventListener(WALLPAPER_CHANGE_EVENT, sync);
      this.cleanups.push(() => { window.removeEventListener("storage", sync); window.removeEventListener(WALLPAPER_CHANGE_EVENT, sync); });
    }
    this.started = true; const generation = ++this.startGeneration;
    const active = () => this.started && generation === this.startGeneration;
    // Hydrate even offline, without delaying lifecycle/power initialization. Keep
    // snapshot refreshes ordered with clear/remove so late reads cannot undo them.
    if (this.options.cache!.stats) {
      void this.mutateCache(async () => {
        if (active()) await this.options.cache!.stats!();
      }).then(() => { if (active()) this.notify(); }, () => { /* Cache failure must not prevent startup. */ });
    }
    if (typeof matchMedia !== "undefined") {
      const media = matchMedia("(prefers-reduced-motion: reduce)");
      const update = () => { if (active()) this.setConditions({}); };
      media.addEventListener("change", update);
      this.cleanups.push(() => media.removeEventListener("change", update));
    }
    let batteryRead: Promise<void> | undefined;
    let batteryGeneration = 0;
    const refreshBattery = (): Promise<void> => {
      if (!active()) return Promise.resolve();
      if (batteryRead) return batteryRead;
      const readGeneration = batteryGeneration;
      const request = (async () => {
        // Read independent native signals together; neither failure masks the other.
        const [battery, power] = await Promise.allSettled([
          Promise.resolve().then(() => (this.options.device ?? Device).getBatteryInfo()),
          Promise.resolve().then(() => (this.options.power ?? getMobilePowerState)()),
        ]);
        if (!active() || readGeneration !== batteryGeneration) return;
        const info = battery.status === "fulfilled" ? battery.value : null;
        const osPower = power.status === "fulfilled" ? power.value : null;
        this.setConditions({
          battery: typeof info?.isCharging === "boolean" ? (info.isCharging ? "charging" : "not-charging") : "unknown",
          batteryLevel: batteryLevel(info?.batteryLevel),
          lowPower: typeof osPower?.lowPower === "boolean" ? osPower.lowPower : null,
        });
      })().finally(() => { if (batteryRead === request) batteryRead = undefined; });
      batteryRead = request;
      return request;
    };
    const poll = setInterval(() => {
      if (active() && this.conditions.lifecycle === "foreground") void refreshBattery();
    }, 60_000);
    this.cleanups.push(() => clearInterval(poll));
    const app = this.options.app ?? App;
    let appLifecycle: MobileLifecycle = "unknown";
    let appStateVersion = 0;
    const applyLifecycle = () => {
      if (!active()) return;
      const lifecycle = typeof document !== "undefined" && document.visibilityState === "hidden" ? "background" : appLifecycle;
      if (lifecycle !== this.conditions.lifecycle) { batteryGeneration++; batteryRead = undefined; }
      const enteringForeground = lifecycle === "foreground" && this.conditions.lifecycle !== "foreground";
      this.setConditions({ lifecycle, ...(enteringForeground ? { battery: "unknown" as const, batteryLevel: null, lowPower: null } : {}) });
      if (enteringForeground) void refreshBattery();
    };
    if (typeof document !== "undefined") {
      const visibilityDocument = document;
      visibilityDocument.addEventListener("visibilitychange", applyLifecycle);
      this.cleanups.push(() => visibilityDocument.removeEventListener("visibilitychange", applyLifecycle));
    }
    try {
      const handle = await app.addListener("appStateChange", ({ isActive }) => {
        if (!active()) return;
        appStateVersion++;
        appLifecycle = typeof isActive === "boolean" ? (isActive ? "foreground" : "background") : "unknown";
        applyLifecycle();
      });
      this.addCleanup(() => { void handle.remove(); }, generation, () => { void handle.remove(); });
    } catch { if (active()) this.setConditions({ lifecycle: "unknown" }); }
    if (!active()) return;
    const stateVersion = appStateVersion;
    try {
      const state = await app.getState?.();
      if (active() && stateVersion === appStateVersion && state) {
        appLifecycle = state.isActive ? "foreground" : "background";
        applyLifecycle();
      }
    } catch { /* Retain listener state, or unknown until an event arrives. */ }
    if (!active()) return;
    const network = this.options.network ?? Network;
    try {
      const status = await network.getStatus();
      if (!active()) return;
      this.setConditions({ network: status.connected === false ? "none" : connectionType(status.connectionType) });
      if (network.addListener) {
        const handle = await network.addListener("networkStatusChange", (next) => active() && this.setConditions({ network: next.connected === false ? "none" : connectionType(next.connectionType) }));
        this.addCleanup(() => { void handle.remove(); }, generation, () => { void handle.remove(); });
      }
    } catch { if (this.started && generation === this.startGeneration) this.setConditions({ network: "unknown" }); }
    if (!active()) return;
    const fallbackGeneration = batteryGeneration;
    await refreshBattery();
    if (!active()) return;
    if (fallbackGeneration === batteryGeneration && this.conditions.battery === "unknown") {
      const getBattery = this.options.battery ?? (typeof navigator !== "undefined" ? (navigator as BatteryNavigator).getBattery?.bind(navigator) : undefined);
      if (getBattery) try {
        const battery = await getBattery();
        if (!active() || fallbackGeneration !== batteryGeneration) return;
        const update = () => { if (active() && this.conditions.lifecycle === "foreground") this.setConditions({ battery: typeof battery.charging === "boolean" ? (battery.charging ? "charging" : "not-charging") : "unknown", batteryLevel: batteryLevel(battery.level) }); };
        update(); battery.addEventListener("chargingchange", update); battery.addEventListener("levelchange", update);
        this.cleanups.push(() => { battery.removeEventListener("chargingchange", update); battery.removeEventListener("levelchange", update); });
      } catch { /* Battery reporting is unavailable. */ }
    }
    if (active()) this.scheduleRotation();
  }
  stop(): void { this.started = false; this.startGeneration++; this.cleanups.splice(0).forEach((cleanup) => cleanup()); this.setConditions({ lifecycle: "unknown" }); this.cancelDownloads(); this.clearRotationTimer(); }
  setPreferences(patch: Partial<MobilePreferences>): MobilePreferences { this.preferences = writeMobilePreferences({ ...this.preferences, ...patch }, this.options.storage); this.notify(); this.scheduleRotation(); return this.preferences; }
  selectBackground(id: string): BackgroundDefinition { const background = getBackground(isBackgroundId(id) ? id : NO_BACKGROUND); this.setPreferences({ background: background.id }); return background; }
  advanceBackgroundRotation(now = this.options.now()): string | null {
    const items = resolvePlaylistItems(this.preferences.rotation.playlistId, this.preferences.rotation.custom, new Date(now));
    const next = pickNextBackground(items, this.preferences.background, this.preferences.rotation.order);
    if (!next) return null;
    this.setPreferences({ background: next, rotation: { ...this.preferences.rotation, lastSwitchAt: now } }); return next;
  }
  private clearRotationTimer() { if (this.rotationTimer !== undefined) clearTimeout(this.rotationTimer); this.rotationTimer = undefined; }
  private scheduleRotation() {
    this.clearRotationTimer(); const rotation = this.preferences.rotation; const snapshot = this.getSnapshot();
    if (!this.started || !rotation.enabled || !snapshot.canAnimate) return;
    const due = Math.max(0, rotation.lastSwitchAt + rotation.interval * 60_000 - this.options.now());
    this.rotationTimer = setTimeout(() => { this.rotationTimer = undefined; if (this.getSnapshot().canAnimate) this.advanceBackgroundRotation(); }, Math.max(0, due));
  }
  getCacheStatus(): MobileCacheStatus { return this.options.cache!.getStatus(); }
  getVideoStatus(url: string): VideoStatus {
    const blob = this.options.cache!.peek(url);
    if (blob) return { status: "cached", bytes: blob.size };
    const status = this.statuses.get(url);
    return status?.status === "cached" ? { status: "idle" } : status ?? { status: "idle" };
  }
  getCanDownloadVideo(): boolean { return this.getSnapshot().canDownloadVideo; }
  private mutateCache<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.cacheQueue.then(operation);
    this.cacheQueue = result.catch(() => undefined);
    return result;
  }
  private cancelDownloads(networkOnly = false) {
    if (!networkOnly) this.downloadGeneration++;
    for (const [url, item] of this.downloads) {
      if (networkOnly && !item.needsNetwork) continue;
      item.controller.abort(); this.statuses.delete(url); this.downloads.delete(url);
    }
  }
  async downloadVideo(url: string): Promise<Blob> {
    const cache = this.options.cache!;
    const existing = this.downloads.get(url); if (existing) return existing.promise;
    if (!this.getSnapshot().canPlayVideo) throw new Error("mobile video playback blocked by lifecycle policy");
    const controller = new AbortController(); const generation = this.downloadGeneration;
    let needsNetwork = false;
    const check = () => {
      if (controller.signal.aborted || generation !== this.downloadGeneration || !this.getSnapshot().canPlayVideo || (needsNetwork && !this.getCanDownloadVideo())) throw new DOMException("download cancelled", "AbortError");
    };
    // Defer execution until the request is registered, including synchronous fetch failures.
    const promise = Promise.resolve().then(async () => {
      check();
      let rejectAbort!: (error: Error) => void;
      const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
      const onAbort = () => rejectAbort(new DOMException("download cancelled", "AbortError"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(), this.options.downloadTimeoutMs ?? 30_000);
      try {
        this.statuses.set(url, { status: "downloading" }); this.notify();
        const work = async () => {
          // Persistent reads refresh the in-memory snapshot and may update LRU.
          // Order them with clear/remove and guard both sides of the async read.
          const cached = await this.mutateCache(async () => { check(); return cache.get(url); });
          check();
          if (cached) { this.statuses.delete(url); this.notify(); return cached; }
          if (!this.getCanDownloadVideo()) throw new Error("mobile video download blocked by network policy");
          needsNetwork = true;
          this.downloads.get(url)!.needsNetwork = true;
          const response = await fetch(url, { credentials: "omit", signal: controller.signal });
          check();
          if (!response.ok) throw new Error(`background video ${response.status}`);
          const blob = await response.blob(); check();
          if (!blob.size) throw new Error("background video is empty");
          await this.mutateCache(async () => {
            check(); await cache.put(url, blob);
            try { check(); } catch (error) { await cache.remove(url); throw error; }
          });
          check(); this.statuses.delete(url); this.notify(); return blob;
        };
        return await Promise.race([work(), aborted]);
      } catch (error) {
        if (this.downloads.get(url)?.controller === controller) {
          this.statuses.set(url, controller.signal.aborted ? { status: "idle" } : { status: "error", error: error instanceof Error ? error.message : "background video download failed" });
          this.notify();
        }
        throw error;
      } finally {
        clearTimeout(timeout); controller.signal.removeEventListener("abort", onAbort);
        if (this.downloads.get(url)?.controller === controller) this.downloads.delete(url);
      }
    });
    this.downloads.set(url, { promise, controller, generation, needsNetwork: false }); return promise;
  }
  async retryVideo(url: string): Promise<Blob> {
    await this.removeCachedVideo(url);
    return this.downloadVideo(url);
  }
  async removeCachedVideo(url: string): Promise<void> {
    this.downloads.get(url)?.controller.abort(); this.downloads.delete(url); this.statuses.delete(url);
    await this.mutateCache(() => this.options.cache!.remove(url)); this.notify();
  }
  async clearVideoCache(): Promise<void> {
    this.cancelDownloads(); this.statuses.clear(); this.notify();
    await this.mutateCache(() => this.options.cache!.clear()); this.notify();
  }

}

export const mobileBackgroundPolicy = createMobileBackgroundPolicy();
export function initializeMobileBackgroundPolicy(): () => void {
  if (!mobileBackgroundPolicy.getSnapshot().isNative) return () => undefined;
  initializationRefs++;
  if (initializationRefs === 1) { void mobileBackgroundPolicy.start(); initializationStop = () => mobileBackgroundPolicy.stop(); }
  let released = false;
  return () => { if (released) return; released = true; if (--initializationRefs === 0) { initializationStop?.(); initializationStop = undefined; } };
}
export function createMobileBackgroundPolicy(options: MobileBackgroundPolicyOptions = {}): MobileBackgroundPolicy { return new MobileBackgroundPolicy(options); }
export function getMobileBackground(): BackgroundDefinition { return getBackground(mobileBackgroundPolicy.getSnapshot().preferences.background); }
export const getMobileBackgroundSnapshot = (): MobilePolicySnapshot => mobileBackgroundPolicy.getSnapshot();
export const subscribeMobileBackgroundPolicy = (listener: () => void): (() => void) => mobileBackgroundPolicy.subscribe(listener);
export const getMobileCanDownloadVideo = (): boolean => mobileBackgroundPolicy.getCanDownloadVideo();
export function resetMobileBackgroundPolicyForTest() { initializationRefs = 0; initializationStop?.(); initializationStop = undefined; }
