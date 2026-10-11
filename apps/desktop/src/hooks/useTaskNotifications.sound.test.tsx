// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostEvent, RpcClient } from "../rpc";
import type { DaemonEvent, Session } from "../types";
import { emptyCatalog, hostKey, type HostCatalog } from "../hostWorkspace";
import { notifyAttention, setAttentionNotificationPref, setTaskNotificationMode } from "../taskNotifications";
import { playTaskSound, setTaskSoundSettings } from "../taskSounds";
import { setQuietHours } from "../quietHours";
import { taskResultEventKey, useTaskNotifications } from "./useTaskNotifications";

// Keep the hook, delivery and sound implementation real. Only platform I/O is mocked.
const platform = vi.hoisted(() => ({ native: false }));
const plugin = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(), requestPermission: vi.fn(), sendNotification: vi.fn(),
}));
vi.mock("../runtime", () => ({ isTauriRuntime: () => platform.native }));
vi.mock("../mobileRuntime", () => ({ isNativeMobileApp: () => false }));
vi.mock("@tauri-apps/plugin-notification", () => plugin);
vi.mock("../turnBadge", () => ({
  createTurnBadge: () => ({ recordTurnEnd: vi.fn(), clear: vi.fn() }),
  clearTurnBadgeOnFocus: () => () => undefined,
}));
vi.mock("../appBadge", () => ({ startAppBadge: () => () => undefined }));
vi.mock("../remotePush", () => ({ startRemotePush: () => () => undefined }));

const web = Object.assign(vi.fn(function () {}), {
  permission: "granted" as NotificationPermission, requestPermission: vi.fn(),
});
function audio() {
  return {
    state: "running", currentTime: 0, destination: {}, resume: vi.fn(),
    createGain: vi.fn(() => ({
      gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() },
      connect: vi.fn(), disconnect: vi.fn(),
    })),
    createOscillator: vi.fn(() => ({
      frequency: { setValueAtTime: vi.fn() }, type: "sine",
      connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(),
    })),
  };
}
let context: ReturnType<typeof audio>;
let Constructor: ReturnType<typeof vi.fn>;
let testId = 0;
let sessionId: string;

beforeEach(() => {
  if (context) context.state = "closed";
  context = audio();
  Constructor = vi.fn(function () { return context; });
  vi.stubGlobal("AudioContext", Constructor);
  vi.stubGlobal("Notification", web);
  vi.stubGlobal("__TAURI_INTERNALS__", { metadata: { currentWindow: { label: "main" } }, invoke: async () => false });
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  localStorage.clear();
  sessionId = `sound-session-${++testId}`;
  platform.native = false;
  web.mockReset();
  web.permission = "granted";
  web.requestPermission.mockReset();
  plugin.isPermissionGranted.mockReset().mockResolvedValue(true);
  plugin.requestPermission.mockReset();
  plugin.sendNotification.mockReset();
});
afterEach(() => {
  cleanup();
  context.state = "closed";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function gesture() { document.dispatchEvent(new Event("pointerdown")); }
function setup() {
  const local = new Set<(event: DaemonEvent) => void>();
  const hosts = new Set<(event: HostEvent) => void>();
  const root = {
    onEvent: (listener: (event: DaemonEvent) => void) => { local.add(listener); return () => local.delete(listener); },
    onHostEvent: (listener: (event: HostEvent) => void) => { hosts.add(listener); return () => hosts.delete(listener); },
  } as unknown as RpcClient;
  const entry = (host: string | null): HostCatalog => ({
    ...emptyCatalog(host, host ?? "本机"), state: "connected",
    sessions: [{ id: sessionId, title: "音效任务", status: "idle", updatedAt: "baseline" } as Session],
  });
  const catalogs = { [hostKey(null)]: entry(null), [hostKey("remote")]: entry("remote") };
  const hook = renderHook(({ entries }) => useTaskNotifications(root, entries), { initialProps: { entries: catalogs } });
  const emit = async (event: DaemonEvent, host: string | null = null) => {
    await act(async () => {
      if (host === null) local.forEach((listener) => listener(event));
      else hosts.forEach((listener) => listener({ type: "host_event", hostId: host, event }));
      // Delivery is intentionally fire-and-forget; drain nested native imports
      // before asserting or resetting platform state for the next test.
      await vi.dynamicImportSettled();
    });
  };
  const end = (kind: "completed" | "failed", cursor?: { epoch: string; sequence: number }): DaemonEvent =>
    kind === "completed" ? { type: "turn_completed", sessionId, eventCursor: cursor }
      : { type: "turn_failed", sessionId, error: "private error", eventCursor: cursor };
  const status = (value: Session["status"]): DaemonEvent => ({ type: "session_status_changed", sessionId, status: value });
  return { ...hook, emit, end, status, catalogs };
}

describe("real task notification sound wiring", () => {
  it.each(["completed", "failed"] as const)("plays %s with denied notification permission and notification mode off", async (kind) => {
    gesture();
    web.permission = "denied";
    const hook = setup();
    await hook.emit(hook.end(kind, { epoch: "run", sequence: 1 }));
    expect(context.createOscillator).toHaveBeenCalledTimes(2);
    expect(web).not.toHaveBeenCalled();
    expect(web.requestPermission).not.toHaveBeenCalled();
    setTaskNotificationMode("off");
    web.permission = "granted";
    await hook.emit(hook.end(kind, { epoch: "run", sequence: 2 }));
    expect(context.createOscillator).toHaveBeenCalledTimes(4);
    expect(web).not.toHaveBeenCalled();
  });

  it("plays even if the native notification permission lookup or sending fails", async () => {
    gesture();
    platform.native = true;
    const hook = setup();
    plugin.isPermissionGranted.mockRejectedValueOnce(new Error("permission unavailable"));
    await hook.emit(hook.end("completed", { epoch: "native", sequence: 1 }));
    expect(context.createOscillator).toHaveBeenCalledTimes(2);
    plugin.sendNotification.mockImplementation(() => { throw new Error("OS failure"); });
    await hook.emit(hook.end("failed", { epoch: "native", sequence: 2 }));
    expect(context.createOscillator).toHaveBeenCalledTimes(4);
    expect(plugin.sendNotification).toHaveBeenCalledTimes(1);
    expect(plugin.requestPermission).not.toHaveBeenCalled();
    expect(web).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed"] as const)("keeps the %s cursor identity across hook remounts and isolates hosts and epochs", async (kind) => {
    gesture();
    let hook = setup();
    const event = hook.end(kind, { epoch: "run", sequence: 7 });
    await hook.emit(event);
    await hook.emit(event); // Existing seen map still drops live replays.
    expect(web).toHaveBeenCalledTimes(1);
    hook.unmount();
    hook = setup();
    await hook.emit(event); // New hook delivers again; sound dedupe retains the stable key.
    expect(web).toHaveBeenCalledTimes(2);
    expect(context.createOscillator).toHaveBeenCalledTimes(2);
    await hook.emit(event, "remote");
    await hook.emit(hook.end(kind, { epoch: "restart", sequence: 7 }));
    await hook.emit(hook.end(kind, { epoch: "restart", sequence: 8 }));
    expect(context.createOscillator).toHaveBeenCalledTimes(8);
    expect(JSON.stringify(web.mock.calls)).not.toContain("private error");
  });

  it.each(["completed", "failed"] as const)("uses a stable %s transition key without cursors and gives the next turn a new identity", async (kind) => {
    gesture();
    const hook = setup();
    await hook.emit(hook.status("running"));
    await hook.emit(hook.end(kind)); // Some daemons report the terminal status later.
    await hook.emit(hook.status(kind === "completed" ? "idle" : "failed"));
    await hook.emit(hook.end(kind));
    expect(web).toHaveBeenCalledTimes(2);
    expect(context.createOscillator).toHaveBeenCalledTimes(2);
    await hook.emit(hook.status("running"));
    await hook.emit(hook.status(kind === "completed" ? "idle" : "failed"));
    await hook.emit(hook.end(kind));
    expect(context.createOscillator).toHaveBeenCalledTimes(4);
  });

  it("uses the timing message ID for legacy turns and keeps the five-minute dedupe window", async () => {
    gesture();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    const hook = setup();
    const timing: DaemonEvent = { type: "turn_timing_changed", sessionId, messageId: "turn-1", timing: { startedAt: "now", status: "completed" } };
    await hook.emit(timing);
    await hook.emit(hook.end("completed"));
    const key = taskResultEventKey(null, sessionId, "completed", { turnId: "turn-1" });
    expect(await playTaskSound("completed", { dedupeKey: JSON.stringify([null, null, sessionId, key]) })).toBe(false);
    vi.setSystemTime(300_999);
    await hook.emit(hook.end("completed"));
    expect(context.createOscillator).toHaveBeenCalledTimes(2);
    vi.setSystemTime(301_000);
    await hook.emit(hook.end("completed"));
    expect(context.createOscillator).toHaveBeenCalledTimes(4);
    await hook.emit({ ...timing, messageId: "turn-2" });
    await hook.emit(hook.end("completed"));
    expect(context.createOscillator).toHaveBeenCalledTimes(6);
  });

  it("lets sound settings, quiet hours and gesture gating control audio without blocking notifications", async () => {
    const hook = setup();
    await hook.emit(hook.end("completed", { epoch: "settings", sequence: 1 }));
    expect(Constructor).not.toHaveBeenCalled();
    expect(web).toHaveBeenCalledTimes(1);
    gesture();
    setTaskSoundSettings({ enabled: false });
    await hook.emit(hook.end("completed", { epoch: "settings", sequence: 2 }));
    setTaskSoundSettings({ enabled: true, failed: false });
    await hook.emit(hook.end("failed", { epoch: "settings", sequence: 3 }));
    setQuietHours({ start: "00:00", end: "00:00" });
    await hook.emit(hook.end("completed", { epoch: "settings", sequence: 4 }));
    expect(context.createOscillator).not.toHaveBeenCalled();
    expect(web).toHaveBeenCalledTimes(4);
    setQuietHours(null);
    vi.mocked(document.hasFocus).mockReturnValue(true);
    await hook.emit(hook.end("completed", { epoch: "settings", sequence: 5 }));
    expect(context.createOscillator).toHaveBeenCalledTimes(2);
    setTaskSoundSettings({ backgroundOnly: true });
    await hook.emit(hook.end("completed", { epoch: "settings", sequence: 6 }));
    expect(context.createOscillator).toHaveBeenCalledTimes(2);
    expect(web).toHaveBeenCalledTimes(4);
  });

  it.each(["create", "start"] as const)("does not consume the sound key after an oscillator %s failure; notifications still succeed", async (failure) => {
    gesture();
    const hook = setup();
    if (failure === "create") context.createOscillator.mockImplementationOnce(() => { throw new Error("create blocked"); });
    else {
      const oscillator = context.createOscillator();
      context.createOscillator.mockClear().mockReturnValueOnce(oscillator);
      oscillator.start.mockImplementationOnce(() => { throw new Error("start blocked"); });
    }
    await hook.emit(hook.end("failed"));
    expect(web).toHaveBeenCalledTimes(1);
    await hook.emit(hook.end("failed"));
    expect(web).toHaveBeenCalledTimes(2);
    expect(context.createOscillator).toHaveBeenCalledTimes(3);
    await hook.emit(hook.end("failed"));
    expect(web).toHaveBeenCalledTimes(3);
    expect(context.createOscillator).toHaveBeenCalledTimes(3);
  });

  it("keeps approval/question sound independent of attention preferences and notification delivery", async () => {
    gesture();
    web.permission = "denied";
    const target = { host: null, sessionId };
    expect(await notifyAttention("approval", "任务", "审批", undefined, target, "approval-1")).toBe(false);
    setAttentionNotificationPref("question", false);
    web.permission = "granted";
    expect(await notifyAttention("question", "任务", "回答", undefined, target, "question-1")).toBe(false);
    expect(context.createOscillator).toHaveBeenCalledTimes(6);
    expect(web).not.toHaveBeenCalled();
    expect(web.requestPermission).not.toHaveBeenCalled();
    setTaskSoundSettings({ attention: false });
    expect(await notifyAttention("approval", "任务", "审批", undefined, target, "approval-2")).toBe(true);
    expect(web).toHaveBeenCalledTimes(1);
    expect(context.createOscillator).toHaveBeenCalledTimes(6);
  });
});
