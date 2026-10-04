import * as mobilePower from "./mobilePower";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryVideoCache, createMobileBackgroundPolicy, DEFAULT_MOBILE_PREFERENCES } from "./mobileBackgroundPolicy";

describe("mobile background policy", () => {
  beforeEach(() => { vi.spyOn(mobilePower, "getState").mockResolvedValue({ lowPower: false }); });
  const policies: ReturnType<typeof createMobileBackgroundPolicy>[] = [];
  afterEach(() => { policies.splice(0).forEach(policy => policy.stop()); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
  async function ready(options: Parameters<typeof createMobileBackgroundPolicy>[0] = {}) {
    let appState!: (state: { isActive: boolean }) => void;
    const policy = createMobileBackgroundPolicy({
      app: { addListener: async (_event: any, listener: any) => { appState = listener; listener({ isActive: true }); return { remove: vi.fn() }; } } as any,
      network: { getStatus: async () => ({ connected: true, connectionType: "wifi" }) },
      device: { getBatteryInfo: async () => ({ isCharging: true, batteryLevel: 1 }) }, ...options,
    });
    policies.push(policy); await policy.start(); return { policy, appState };
  }

  it("keeps mobile preferences independent and defaults video downloads to Wi-Fi", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: () => {}, clear: () => {}, key: () => null, length: 0 } as unknown as Storage;
    const policy = createMobileBackgroundPolicy({ isNative: () => true, storage });
    expect(policy.getSnapshot().preferences).toMatchObject(DEFAULT_MOBILE_PREFERENCES);
    policy.setPreferences({ network: "cellular-opt-in" });
    expect(policy.getSnapshot().preferences.network).toBe("cellular-opt-in");
    expect(values.get("miniq.mobile.appearance.network")).toBe("cellular-opt-in");
  });

  it("returns a stable snapshot until policy conditions change", () => {
    const policy = createMobileBackgroundPolicy({ isNative: () => true });
    expect(policy.getSnapshot()).toBe(policy.getSnapshot());
    policy.setPreferences({ motion: "low-power" });
    expect(policy.getSnapshot().canDownloadVideo).toBe(false);
  });

  it("enforces cache entry and byte limits with oldest-first eviction", async () => {
    const cache = createMemoryVideoCache({ maxEntries: 2, maxBytes: 5 });
    await cache.put("a", new Blob(["123"]));
    await cache.put("b", new Blob(["12"]));
    await cache.put("c", new Blob(["1"]));
    expect(await cache.get("a")).toBeUndefined();
    expect(await cache.get("b")).toBeDefined();
    expect(await cache.get("c")).toBeDefined();
  });

  it("cleans every Capacitor listener when stopped", async () => {
    const removeApp = vi.fn();
    const removeNetwork = vi.fn();
    const policy = createMobileBackgroundPolicy({
      isNative: () => true,
      app: { addListener: async () => ({ remove: removeApp }) },
      network: { getStatus: async () => ({ connected: true, connectionType: "wifi" }), addListener: async () => ({ remove: removeNetwork }) },
      device: { getBatteryInfo: async () => ({ isCharging: true, batteryLevel: 0.8 }) },
    });
    await policy.start();
    policy.stop();
    expect(removeApp).toHaveBeenCalledTimes(1);
    expect(removeNetwork).toHaveBeenCalledTimes(1);
  });

  it("reads native battery state and keeps an unknown lifecycle conservative", async () => {
    let appState: ((state: { isActive: boolean }) => void) | undefined;
    const policy = createMobileBackgroundPolicy({
      isNative: () => true,
      app: { addListener: async (_event: any, listener: any) => { appState = listener; return { remove: vi.fn() }; } } as any,
      network: { getStatus: async () => ({ connected: true, connectionType: "wifi" }) },
      device: { getBatteryInfo: async () => ({ isCharging: false, batteryLevel: 0.1 }) },
    });
    await policy.start();
    expect(policy.getSnapshot().conditions.lifecycle).toBe("unknown");
    expect(policy.getSnapshot().conditions.batteryLevel).toBe(0.1);
    expect(policy.getSnapshot().canDownloadVideo).toBe(false);
    appState?.({ isActive: true });
    expect(policy.getSnapshot().canDownloadVideo).toBe(false);
  });

  it("deduplicates downloads and refuses empty responses", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const policy = createMobileBackgroundPolicy({
      isNative: () => true,
      app: { addListener: async (_event: any, listener: any) => { listener({ isActive: true } as any); return { remove: vi.fn() }; } } as any,
      network: { getStatus: async () => ({ connected: true, connectionType: "wifi" }) },
      device: { getBatteryInfo: async () => ({ isCharging: true, batteryLevel: 1 }) },
    });
    await policy.start();
    const first = policy.downloadVideo("https://example.test/a.mp4");
    const second = policy.downloadVideo("https://example.test/a.mp4");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveResponse(new Response(new Blob()));
    await expect(first).rejects.toThrow("empty");
    await expect(second).rejects.toThrow("empty");
    vi.unstubAllGlobals();
  });

  it("does not let a cancelled request write into the cache", async () => {
    let release!: (response: Response) => void;
    const put = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
    const cache = { ...createMemoryVideoCache(), put };
    let appState!: (state: { isActive: boolean }) => void;
    const policy = createMobileBackgroundPolicy({
      isNative: () => true,
      app: { addListener: async (_event: any, listener: any) => { appState = listener; listener({ isActive: true } as any); return { remove: vi.fn() }; } } as any,
      network: { getStatus: async () => ({ connected: true, connectionType: "wifi" }) },
      device: { getBatteryInfo: async () => ({ isCharging: true, batteryLevel: 1 }) }, cache,
    });
    await policy.start();
    const pending = policy.downloadVideo("https://example.test/b.mp4");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    appState({ isActive: false });
    appState({ isActive: true });
    release(new Response(new Blob(["late"])));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(put).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("keeps the default cache across calls and clears it", async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(["video"])));
    vi.stubGlobal("fetch", fetchMock);
    const policy = createMobileBackgroundPolicy({
      app: { addListener: async (_event: any, listener: any) => { listener({ isActive: true }); return { remove: vi.fn() }; } } as any,
      network: { getStatus: async () => ({ connected: true, connectionType: "wifi" }) },
      device: { getBatteryInfo: async () => ({ isCharging: true, batteryLevel: 1 }) },
    });
    try {
      await policy.start();
      await policy.downloadVideo("video");
      await policy.downloadVideo("video");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await policy.clearVideoCache();
      expect(policy.getVideoStatus("video").status).toBe("idle");
      await policy.downloadVideo("video");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally { policy.stop(); vi.unstubAllGlobals(); }
  });

  it("honors system reduced motion even with standard motion selected", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    try {
      const policy = createMobileBackgroundPolicy();
      policy.setPreferences({ motion: "standard" });
      expect(policy.getSnapshot().reducedMotion).toBe(true);
      expect(policy.getSnapshot().canAnimate).toBe(false);
    } finally { vi.unstubAllGlobals(); }
  });

  it("reports actual eviction and cache totals", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["123"]))));
    const { policy } = await ready({ cache: createMemoryVideoCache({ maxEntries: 1, maxBytes: 4 }) });
    await policy.downloadVideo("a"); await policy.downloadVideo("b");
    expect(policy.getVideoStatus("a").status).toBe("idle");
    expect(policy.getVideoStatus("b")).toEqual({ status: "cached", bytes: 3 });
    expect(policy.getCacheStatus()).toEqual({ items: 1, bytes: 3, maxEntries: 1, maxBytes: 4 });
    await policy.clearVideoCache(); expect(policy.getCacheStatus().items).toBe(0);
  });

  it.each(["clear", "network"])("cancels on %s even if fetch ignores abort and policy recovers", async (reason) => {
    let release!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
    const { policy } = await ready({ network: { getStatus: async () => ({ connected: true, connectionType: "cellular" }) } });
    policy.setPreferences({ network: "cellular-opt-in" });
    const result = policy.downloadVideo("late");
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    if (reason === "clear") await policy.clearVideoCache();
    else { policy.setPreferences({ network: "wifi-only" }); policy.setPreferences({ network: "cellular-opt-in" }); }
    await rejected;
    release(new Response(new Blob(["late"])));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(policy.getCacheStatus().items).toBe(0);
    expect(policy.getVideoStatus("late").status).toBe("idle");
  });

  it("serializes clearing with an already pending asynchronous cache write", async () => {
    const base = createMemoryVideoCache();
    let release!: () => void;
    const put = vi.fn(async (url: string, blob: Blob) => { await new Promise<void>(resolve => { release = resolve; }); await base.put(url, blob); });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["late"]))));
    const { policy } = await ready({ cache: { ...base, put } });
    const pending = policy.downloadVideo("a");
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(put).toHaveBeenCalled());
    const clearing = policy.clearVideoCache(); release();
    await Promise.all([clearing, rejected]);
    expect(policy.getCacheStatus().items).toBe(0);
  });

  it("loads persisted video through get even when peek is empty, deduplicating reads", async () => {
    const saved = new Blob(["persisted"]);
    const get = vi.fn(async () => saved);
    const put = vi.fn();
    vi.stubGlobal("fetch", vi.fn());
    const { policy } = await ready({ cache: { ...createMemoryVideoCache(), get, put } });
    const results = await Promise.all([policy.downloadVideo("disk"), policy.downloadVideo("disk")]);
    expect(results).toEqual([saved, saved]);
    expect(get).toHaveBeenCalledExactlyOnceWith("disk");
    expect(fetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it.each(["clear", "remove", "background", "stop"])("guards a deferred disk read cancelled by %s", async reason => {
    let release!: (blob: Blob | undefined) => void;
    const base = createMemoryVideoCache();
    const get = vi.fn(() => new Promise<Blob | undefined>(resolve => { release = resolve; }));
    const put = vi.spyOn(base, "put");
    vi.stubGlobal("fetch", vi.fn());
    const { policy, appState } = await ready({ cache: { ...base, get } });
    const rejected = expect(policy.downloadVideo("disk")).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(get).toHaveBeenCalled());
    let mutation: Promise<void> | undefined;
    if (reason === "clear") mutation = policy.clearVideoCache();
    if (reason === "remove") mutation = policy.removeCachedVideo("disk");
    if (reason === "background") appState({ isActive: false });
    if (reason === "stop") policy.stop();
    await rejected; // Cancellation must settle even while disk is unresponsive.
    release(new Blob(["late disk result"]));
    await mutation;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(policy.getVideoStatus("disk").status).toBe("idle");
  });

  it.each(["background", "network"])("aborts the actual fetch signal when %s revokes permission", async reason => {
    let signal!: AbortSignal;
    vi.stubGlobal("fetch", vi.fn((_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    }));
    let networkChange!: (status: { connected: boolean; connectionType: string }) => void;
    const { policy, appState } = await ready({ network: {
      getStatus: async () => ({ connected: true, connectionType: "wifi" }),
      addListener: async (_event, listener) => { networkChange = listener; return { remove: vi.fn() }; },
    } });
    const rejected = expect(policy.downloadVideo("active")).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(signal.aborted).toBe(false);
    if (reason === "background") appState({ isActive: false });
    else networkChange({ connected: true, connectionType: "cellular" });
    expect(signal.aborted).toBe(true);
    await rejected;
  });

  it("clears deferred writes before a new download of the same URL can commit", async () => {
    const base = createMemoryVideoCache();
    let release!: () => void;
    const put = vi.fn(async (url: string, blob: Blob) => {
      if (put.mock.calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
      await base.put(url, blob);
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("old")).mockResolvedValueOnce(new Response("new"));
    vi.stubGlobal("fetch", fetchMock);
    const { policy } = await ready({ cache: { ...base, put } });
    const rejected = expect(policy.downloadVideo("same")).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());
    const clearing = policy.clearVideoCache();
    const next = policy.downloadVideo("same");
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release();
    await clearing;
    expect(await (await next).text()).toBe("new");
    expect(await (await base.get("same"))?.text()).toBe("new");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["none", "unknown", "cellular"])("plays cached video on %s without authorizing downloads", async connectionType => {
    const saved = new Blob(["offline"]);
    const get = vi.fn(async (): Promise<Blob | undefined> => saved);
    vi.stubGlobal("fetch", vi.fn());
    const { policy } = await ready({
      cache: { ...createMemoryVideoCache(), get },
      network: { getStatus: async () => ({ connectionType }) },
    });
    expect(policy.getSnapshot()).toMatchObject({ canPlayVideo: true, canDownloadVideo: false });
    expect(await policy.downloadVideo("disk")).toBe(saved);
    get.mockResolvedValueOnce(undefined);
    await expect(policy.downloadVideo("missing")).rejects.toThrow("network policy");
    expect(fetch).not.toHaveBeenCalled();
    if (connectionType === "cellular") {
      policy.setPreferences({ network: "cellular-opt-in" });
      expect(policy.getSnapshot().canDownloadVideo).toBe(true);
    }
  });

  it.each([true, false])("rechecks network after a deferred cache read (hit=%s)", async hit => {
    let release!: (blob: Blob | undefined) => void;
    const get = vi.fn(() => new Promise<Blob | undefined>(resolve => { release = resolve; }));
    let networkChange!: (status: { connected: boolean; connectionType: string }) => void;
    vi.stubGlobal("fetch", vi.fn());
    const { policy } = await ready({ cache: { ...createMemoryVideoCache(), get }, network: {
      getStatus: async () => ({ connectionType: "wifi" }),
      addListener: async (_event, listener) => { networkChange = listener; return { remove: vi.fn() }; },
    } });
    const pending = policy.downloadVideo("disk");
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
    networkChange({ connected: false, connectionType: "none" });
    const saved = new Blob(["cached"]);
    release(hit ? saved : undefined);
    if (hit) expect(await pending).toBe(saved);
    else await expect(pending).rejects.toThrow("network policy");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["clear", "remove"])("orders an offline disk snapshot refresh before %s and a replacement read", async reason => {
    const base = createMemoryVideoCache();
    let release!: () => void;
    const get = vi.fn(async (url: string) => {
      if (get.mock.calls.length === 1) {
        await new Promise<void>(resolve => { release = resolve; });
        await base.put(url, new Blob(["old disk snapshot"]));
      }
      return base.get(url);
    });
    vi.stubGlobal("fetch", vi.fn());
    const { policy } = await ready({ cache: { ...base, get }, network: { getStatus: async () => ({ connected: false }) } });
    const cancelled = expect(policy.downloadVideo("disk")).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
    const mutation = reason === "clear" ? policy.clearVideoCache() : policy.removeCachedVideo("disk");
    const replacement = expect(policy.downloadVideo("disk")).rejects.toThrow("network policy");
    await cancelled;
    release();
    await Promise.all([mutation, replacement]);
    expect(base.peek("disk")).toBeUndefined();
    expect(policy.getCacheStatus().items).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["background", "low-power", "reduced-motion", "battery", "unknown-power"])("keeps offline cached playback subject to %s safety", async reason => {
    const media = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal("matchMedia", () => media);
    const get = vi.fn(async () => new Blob(["cached"]));
    vi.stubGlobal("fetch", vi.fn());
    const { policy, appState } = await ready({
      cache: { ...createMemoryVideoCache(), get },
      network: { getStatus: async () => ({ connected: false }) },
      ...(reason === "battery" ? { device: { getBatteryInfo: async () => ({ isCharging: false, batteryLevel: 0.9 }) } } : {}),
      ...(reason === "unknown-power" ? { power: async () => null } : {}),
    });
    if (reason === "background") appState({ isActive: false });
    if (reason === "low-power") policy.setPreferences({ motion: "low-power" });
    if (reason === "reduced-motion") { media.matches = true; media.dispatchEvent(new Event("change")); }
    expect(policy.getSnapshot()).toMatchObject({ canPlayVideo: false, canDownloadVideo: false });
    await expect(policy.downloadVideo("disk")).rejects.toThrow("playback blocked");
    expect(get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes battery on resume, polls only in foreground and cleans up", async () => {
    vi.useFakeTimers();
    const getBatteryInfo = vi.fn(async () => ({ isCharging: false, batteryLevel: 0.8 }));
    const { policy, appState } = await ready({ device: { getBatteryInfo } });
    getBatteryInfo.mockResolvedValue({ isCharging: false, batteryLevel: 0.1 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(policy.getSnapshot().canAnimate).toBe(false);
    expect(policy.getSnapshot().conditions.batteryLevel).toBe(0.1);
    appState({ isActive: false }); const count = getBatteryInfo.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000); expect(getBatteryInfo).toHaveBeenCalledTimes(count);
    getBatteryInfo.mockResolvedValue({ isCharging: false, batteryLevel: 0.9 });
    appState({ isActive: true }); await vi.advanceTimersByTimeAsync(0);
    expect(policy.getSnapshot().conditions.batteryLevel).toBe(0.9);
    expect(policy.getSnapshot().osLowPowerModeSupported).toBe(true);
    policy.stop(); const stopped = getBatteryInfo.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000); expect(getBatteryInfo).toHaveBeenCalledTimes(stopped);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out even when fetch ignores its AbortSignal", async () => {
    vi.useFakeTimers(); vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { policy } = await ready({ downloadTimeoutMs: 100 });
    const rejected = expect(policy.downloadVideo("stalled")).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(100); await rejected;
    expect(policy.getVideoStatus("stalled").status).toBe("idle");
  });

  it("renders the singleton memory selection without storage", async () => {
    const { mobileBackgroundPolicy, getMobileBackground } = await import("./mobileBackgroundPolicy");
    const { BACKGROUNDS } = await import("./backgroundCatalog");
    const previous = mobileBackgroundPolicy.getSnapshot().preferences;
    vi.stubGlobal("localStorage", undefined);
    try {
      const target = BACKGROUNDS.find(item => item.id !== previous.background)!;
      mobileBackgroundPolicy.selectBackground(target.id);
      expect(getMobileBackground().id).toBe(target.id);
    } finally { mobileBackgroundPolicy.setPreferences(previous); }
  });

  it("reads initial App state without waiting for an event", async () => {
    const getState = vi.fn(async () => ({ isActive: true }));
    const { policy } = await ready({ app: { addListener: async () => ({ remove: vi.fn() }), getState } });
    expect(getState).toHaveBeenCalledOnce();
    expect(policy.getSnapshot()).toMatchObject({ conditions: { lifecycle: "foreground" }, canAnimate: true });
  });

  it("does not overwrite newer lifecycle events with a late initial read", async () => {
    let listener!: (state: { isActive: boolean }) => void;
    let release!: (state: { isActive: boolean }) => void;
    const state = new Promise<{ isActive: boolean }>(resolve => { release = resolve; });
    const getState = vi.fn(() => state);
    const policy = createMobileBackgroundPolicy({ app: { addListener: async (_event, callback) => { listener = callback as (state: { isActive: boolean }) => void; return { remove: vi.fn() }; }, getState } });
    policies.push(policy);
    const starting = policy.start();
    await vi.waitFor(() => expect(getState).toHaveBeenCalled());
    listener({ isActive: false }); release({ isActive: true }); await starting;
    expect(policy.getSnapshot().conditions.lifecycle).toBe("background");
  });

  it("reacts to document visibility and removes its listener on stop", async () => {
    const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const remove = vi.spyOn(doc, "removeEventListener");
    vi.stubGlobal("document", doc);
    const { policy } = await ready();
    expect(policy.getSnapshot().canAnimate).toBe(true);
    doc.visibilityState = "hidden"; doc.dispatchEvent(new Event("visibilitychange"));
    expect(policy.getSnapshot()).toMatchObject({ conditions: { lifecycle: "background" }, canAnimate: false, canDownloadVideo: false });
    doc.visibilityState = "visible"; doc.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(policy.getSnapshot().canAnimate).toBe(true));
    policy.stop();
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(policy.getSnapshot().conditions.lifecycle).toBe("unknown");
  });

  it("reacts to system motion changes in standard mode and cleans the listener", async () => {
    const media = Object.assign(new EventTarget(), { matches: false });
    const remove = vi.spyOn(media, "removeEventListener");
    vi.stubGlobal("matchMedia", () => media);
    const { policy } = await ready();
    policy.setPreferences({ motion: "standard" });
    const notify = vi.fn(); const unsubscribe = policy.subscribe(notify);
    expect(policy.getSnapshot().canAnimate).toBe(true);
    media.matches = true; media.dispatchEvent(new Event("change"));
    expect(policy.getSnapshot()).toMatchObject({ reducedMotion: true, canAnimate: false, canDownloadVideo: false });
    expect(notify).toHaveBeenCalled();
    media.matches = false; media.dispatchEvent(new Event("change"));
    expect(policy.getSnapshot().canAnimate).toBe(true);
    unsubscribe(); policy.stop();
    expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("blocks animations when battery safety is unknown", async () => {
    const { policy } = await ready({ device: { getBatteryInfo: async () => { throw new Error("unsupported"); } }, battery: async () => { throw new Error("unsupported"); } });
    expect(policy.getSnapshot()).toMatchObject({ conditions: { lifecycle: "foreground", battery: "unknown" }, canAnimate: false, canDownloadVideo: false });
  });

  it("uses the native power adapter and honors OS low power in every motion mode", async () => {
    const getState = vi.spyOn(mobilePower, "getState").mockResolvedValue({ lowPower: true });
    const { policy } = await ready();
    expect(getState).toHaveBeenCalled();
    expect(policy.getSnapshot()).toMatchObject({ conditions: { lowPower: true }, osLowPowerModeSupported: true, canAnimate: false, canDownloadVideo: false });
    policy.setPreferences({ motion: "standard" });
    expect(policy.getSnapshot().canAnimate).toBe(false);
    policy.setPreferences({ motion: "system" });
    expect(policy.getSnapshot().canAnimate).toBe(false);
  });

  it.each([null, "throw"] as const)("keeps unknown OS power explicit (%s) and disables animation conservatively", async value => {
    const { policy } = await ready({ power: async () => { if (value === "throw") throw new Error("native failure"); return null; } });
    expect(policy.getSnapshot()).toMatchObject({ conditions: { lowPower: null }, osLowPowerModeSupported: false, canAnimate: false });
  });

  it("polls OS power in foreground, cancels downloads, refreshes on resume, and cleans up", async () => {
    vi.useFakeTimers();
    let state: { lowPower: boolean } | null = { lowPower: false };
    const power = vi.fn(async () => state);
    const { policy, appState } = await ready({ power, downloadTimeoutMs: 120_000 });
    expect(policy.getSnapshot().canDownloadVideo).toBe(true);
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const download = policy.downloadVideo("pending");
    const cancelled = expect(download).rejects.toMatchObject({ name: "AbortError" });
    state = { lowPower: true };
    await vi.advanceTimersByTimeAsync(60_000); await cancelled;
    expect(policy.getSnapshot().canAnimate).toBe(false);
    appState({ isActive: false });
    const count = power.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(power).toHaveBeenCalledTimes(count);
    state = null; appState({ isActive: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(policy.getSnapshot()).toMatchObject({ conditions: { lowPower: null }, osLowPowerModeSupported: false, canAnimate: false });
    policy.stop(); const stoppedCount = power.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(power).toHaveBeenCalledTimes(stoppedCount);
  });

  it("ignores a native power response arriving after stop", async () => {
    let resolve!: (state: { lowPower: boolean }) => void;
    const pending = new Promise<{ lowPower: boolean }>(done => { resolve = done; });
    const power = vi.fn(() => pending);
    const policy = createMobileBackgroundPolicy({ power }); policies.push(policy);
    const starting = policy.start();
    await vi.waitFor(() => expect(power).toHaveBeenCalled());
    policy.stop(); resolve({ lowPower: true }); await starting;
    expect(policy.getSnapshot()).toMatchObject({ conditions: { lifecycle: "unknown", lowPower: null } });
  });

  it("allows safe canvas motion on battery but requires charging for video", async () => {
    const { policy } = await ready({ device: { getBatteryInfo: async () => ({ isCharging: false, batteryLevel: 0.9 }) } });
    expect(policy.getSnapshot()).toMatchObject({ canAnimate: true, canPlayVideo: false, canDownloadVideo: false });
    await expect(policy.downloadVideo("battery-only")).rejects.toThrow();
  });

  it("cancels a video download when charging stops even at high battery level", async () => {
    vi.useFakeTimers();
    const device = { getBatteryInfo: vi.fn(async () => ({ isCharging: true, batteryLevel: 0.9 })) };
    const { policy } = await ready({ device, downloadTimeoutMs: 120_000 });
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const cancelled = expect(policy.downloadVideo("unplugged")).rejects.toMatchObject({ name: "AbortError" });
    device.getBatteryInfo.mockResolvedValue({ isCharging: false, batteryLevel: 0.9 });
    await vi.advanceTimersByTimeAsync(60_000); await cancelled;
    expect(policy.getSnapshot()).toMatchObject({ canAnimate: true, canPlayVideo: false, canDownloadVideo: false });
  });

});
