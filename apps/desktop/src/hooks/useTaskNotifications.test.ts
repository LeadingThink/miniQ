// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonEvent } from "../types";

const mocks = vi.hoisted(() => ({
  mobile: true,
  notifyMobileTask: vi.fn(async () => true),
  notifyTaskResult: vi.fn(async () => true),
  pushStatus: "unsupported",
}));

vi.mock("../remotePush", () => ({
  getRemotePushStatus: () => mocks.pushStatus,
  isRemotePushCovering: () => false,
  startRemotePush: () => () => undefined,
}));

vi.mock("../mobileRuntime", () => ({ isNativeMobileApp: () => mocks.mobile }));
vi.mock("../taskNotifications", () => ({
  notifyMobileTask: mocks.notifyMobileTask,
  notifyTaskResult: mocks.notifyTaskResult,
  isAppInBackground: async () => false,
}));
vi.mock("@capacitor/local-notifications", () => ({
  LocalNotifications: { addListener: vi.fn(async () => ({ remove: vi.fn() })) },
}));

import { CATCH_UP_WINDOW_MS, SHORT_TASK_MS, missedKind, useTaskNotifications } from "./useTaskNotifications";

type Listener = (event: DaemonEvent) => void;
function fakeRoot() {
  const local = new Set<Listener>();
  const host = new Set<(event: unknown) => void>();
  return {
    client: {
      onEvent: (listener: Listener) => { local.add(listener); return () => local.delete(listener); },
      onHostEvent: (listener: (event: unknown) => void) => { host.add(listener); return () => host.delete(listener); },
    },
    emit: (event: Record<string, unknown>) => act(() => { local.forEach((listener) => listener(event as unknown as DaemonEvent)); }),
    emitHost: (hostId: string, event: Record<string, unknown>) => act(() => {
      host.forEach((listener) => listener({ type: "host_event", hostId, event }));
    }),
  };
}

const catalogs = {
  [JSON.stringify(null)]: { label: "本机", sessions: [{ id: "s1", title: "整理报告" }] },
  [JSON.stringify("mac")]: { label: "办公室 Mac", sessions: [{ id: "s2", title: "部署" }] },
};

function setup(isViewing = vi.fn(() => false)) {
  const root = fakeRoot();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderHook(() => useTaskNotifications(root.client as any, catalogs as any, { isViewing }));
  return { root, isViewing };
}

let cursor = 0;
const next = () => ({ epoch: "e1", sequence: ++cursor });

beforeEach(() => {
  mocks.mobile = true;
  mocks.pushStatus = "unsupported";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useTaskNotifications on mobile", () => {
  it("raises an attention notice once per waiting period", () => {
    const { root } = setup();
    root.emit({ type: "session_status_changed", sessionId: "s1", status: "waiting_approval", eventCursor: next() });
    root.emit({ type: "session_status_changed", sessionId: "s1", status: "waiting_approval", eventCursor: next() });
    expect(mocks.notifyMobileTask).toHaveBeenCalledTimes(1);
    expect(mocks.notifyMobileTask).toHaveBeenCalledWith("attention", "整理报告", { host: null, sessionId: "s1" }, false, false);
    root.emit({ type: "session_status_changed", sessionId: "s1", status: "running", eventCursor: next() });
    root.emit({ type: "session_status_changed", sessionId: "s1", status: "waiting_approval", eventCursor: next() });
    expect(mocks.notifyMobileTask).toHaveBeenCalledTimes(2);
  });

  it("skips completed turns shorter than the threshold but not failures", () => {
    const { root } = setup();
    root.emit({ type: "session_status_changed", sessionId: "s1", status: "running", eventCursor: next() });
    vi.setSystemTime(SHORT_TASK_MS - 1);
    root.emit({ type: "turn_completed", sessionId: "s1", eventCursor: next() });
    expect(mocks.notifyMobileTask).not.toHaveBeenCalled();
    root.emit({ type: "session_status_changed", sessionId: "s1", status: "running", eventCursor: next() });
    root.emit({ type: "turn_failed", sessionId: "s1", eventCursor: next() });
    expect(mocks.notifyMobileTask).toHaveBeenCalledWith("failed", "整理报告", { host: null, sessionId: "s1" }, false, false);
  });

  it("notifies long completed turns with the remote host label", () => {
    const { root, isViewing } = setup(vi.fn(() => true));
    root.emitHost("mac", { type: "session_status_changed", sessionId: "s2", status: "running", eventCursor: next() });
    vi.setSystemTime(SHORT_TASK_MS + 1);
    root.emitHost("mac", { type: "turn_completed", sessionId: "s2", eventCursor: next() });
    expect(isViewing).toHaveBeenCalledWith("mac", "s2");
    expect(mocks.notifyMobileTask).toHaveBeenCalledWith("completed", "办公室 Mac · 部署", { host: "mac", sessionId: "s2" }, true, false);
  });

  it("ignores replayed events", () => {
    const { root } = setup();
    const replay = next();
    root.emit({ type: "turn_failed", sessionId: "s1", eventCursor: replay });
    root.emit({ type: "turn_failed", sessionId: "s1", eventCursor: replay });
    expect(mocks.notifyMobileTask).toHaveBeenCalledTimes(1);
  });

  it("keeps the desktop path on notifyTaskResult", () => {
    mocks.mobile = false;
    const { root } = setup();
    root.emit({ type: "turn_completed", sessionId: "s1", eventCursor: next() });
    expect(mocks.notifyTaskResult).toHaveBeenCalledWith("completed", "整理报告");
    expect(mocks.notifyMobileTask).not.toHaveBeenCalled();
  });
});

describe("missedKind", () => {
  it("maps catalog transitions to notification kinds", () => {
    expect(missedKind("running", "waiting_approval")).toBe("attention");
    expect(missedKind("idle", "waiting_approval")).toBe("attention");
    expect(missedKind("running", "idle")).toBe("completed");
    expect(missedKind("waiting_approval", "failed")).toBe("failed");
    expect(missedKind("idle", "failed")).toBeNull();
    expect(missedKind("running", "running")).toBeNull();
    expect(missedKind("idle", "running")).toBeNull();
  });
});

describe("reconnect catch-up", () => {
  type Status = "idle" | "running" | "waiting_approval" | "failed";
  const catalogOf = (state: string, status: Status, hostId: string | null = "mac") => ({
    [JSON.stringify(hostId)]: { hostId, label: "办公室 Mac", state, sessions: [{ id: "s2", title: "部署", status }], unreadSessionIds: new Set() },
  });
  function mount(hostId: string | null = "mac") {
    const root = fakeRoot();
    const hook = renderHook(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ value }) => useTaskNotifications(root.client as any, value as any, {}),
      { initialProps: { value: catalogOf("connected", "running", hostId) } },
    );
    const show = (state: string, status: Status) => hook.rerender({ value: catalogOf(state, status, hostId) });
    return { root, show };
  }

  it("notifies statuses missed while disconnected, once", () => {
    const { root, show } = mount();
    show("disconnected", "running");
    show("connected", "running");
    show("connected", "waiting_approval");
    expect(mocks.notifyMobileTask).toHaveBeenCalledWith("attention", "办公室 Mac · 部署", { host: "mac", sessionId: "s2" }, false, false);
    show("connected", "waiting_approval");
    root.emitHost("mac", { type: "session_status_changed", sessionId: "s2", status: "waiting_approval", eventCursor: next() });
    expect(mocks.notifyMobileTask).toHaveBeenCalledTimes(1);
  });

  it("suppresses the late live completion after a catch-up notice", () => {
    const { root, show } = mount();
    show("disconnected", "running");
    show("connected", "failed");
    expect(mocks.notifyMobileTask).toHaveBeenCalledWith("failed", "办公室 Mac · 部署", { host: "mac", sessionId: "s2" }, false, false);
    root.emitHost("mac", { type: "turn_failed", sessionId: "s2", eventCursor: next() });
    expect(mocks.notifyMobileTask).toHaveBeenCalledTimes(1);
  });

  it("ignores ordinary catalog refreshes outside the catch-up window", () => {
    const { show } = mount();
    show("connected", "idle");
    expect(mocks.notifyMobileTask).not.toHaveBeenCalled();
    show("disconnected", "idle");
    show("connected", "running");
    vi.setSystemTime(CATCH_UP_WINDOW_MS + 1);
    show("connected", "idle");
    expect(mocks.notifyMobileTask).not.toHaveBeenCalled();
  });

  it("opens a window on remote_resync", () => {
    const { root, show } = mount();
    root.emitHost("mac", { type: "remote_resync" });
    show("connected", "idle");
    expect(mocks.notifyMobileTask).toHaveBeenCalledWith("completed", "办公室 Mac · 部署", { host: "mac", sessionId: "s2" }, false, false);
  });

  it("leaves the local desktop to the offline push", () => {
    mocks.pushStatus = "active";
    const { show } = mount(null);
    show("disconnected", "running");
    show("connected", "waiting_approval");
    expect(mocks.notifyMobileTask).not.toHaveBeenCalled();
  });
});
