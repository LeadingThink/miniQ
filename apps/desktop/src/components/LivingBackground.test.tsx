// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LivingBackground } from "./LivingBackground";
import { storeBackground } from "../background";
import { BACKGROUNDS } from "../backgroundCatalog";
const state = vi.hoisted(() => ({ native: false, id: "", listeners: new Set<() => void>(), allowed: true, networkAllowed: true, download: vi.fn<() => Promise<Blob>>() }));
vi.mock("../mobileRuntime", () => ({ isNativeMobileApp: () => state.native }));
vi.mock("../mobileBackgroundPolicy", async () => {
  const { getBackground } = await import("../backgroundCatalog");
  let snapshot: { preferences: { motion: string }; conditions: { lowPower: boolean }; isNative: boolean; canAnimate: boolean; canPlayVideo: boolean; canDownloadVideo: boolean };
  const getSnapshot = () => {
    const canDownloadVideo = state.allowed && state.networkAllowed;
    if (!snapshot || snapshot.isNative !== state.native || snapshot.canAnimate !== state.allowed || snapshot.canDownloadVideo !== canDownloadVideo) {
      snapshot = { preferences: { motion: "system" }, conditions: { lowPower: false }, isNative: state.native, canAnimate: state.allowed, canPlayVideo: state.allowed, canDownloadVideo };
    }
    return snapshot;
  };
  return {
    getMobileBackground: () => getBackground(state.id),
    initializeMobileBackgroundPolicy: () => () => {},
    mobileBackgroundPolicy: {
      subscribe: (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); },
      getSnapshot,
      downloadVideo: () => state.download(),
    },
  };
});
vi.mock("../backgroundVideo", () => ({ loadBackgroundVideo: async () => new Blob(["video"]) }));
beforeEach(() => {
  state.native = false; state.allowed = true; state.networkAllowed = true;
  state.download.mockReset().mockResolvedValue(new Blob(["video"]));
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  URL.createObjectURL = vi.fn(() => "blob:video"); URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("keeps desktop background subscriptions live", async () => {
  storeBackground("none");
  const { container } = render(<LivingBackground />);
  const video = BACKGROUNDS.find(x => x.kind === "video")!;
  await act(async () => storeBackground(video.id));
  expect(container.querySelector('[data-kind="video"]')).not.toBeNull();
});
it("uses one native player and releases it when motion is suspended", async () => {
  state.native = true; state.id = BACKGROUNDS.find(x => x.kind === "video")!.id;
  const { container } = render(<LivingBackground />);
  await act(async () => {});
  expect(container.querySelectorAll("video")).toHaveLength(1);
  await act(async () => { state.allowed = false; state.listeners.forEach(fn => fn()); });
  expect(container.querySelectorAll("video")).toHaveLength(0);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:video");
});

it("loads cached native video offline and keeps it mounted when network permission changes", async () => {
  state.native = true; state.networkAllowed = false;
  state.id = BACKGROUNDS.find(x => x.kind === "video")!.id;
  const { container } = render(<LivingBackground />);
  await act(async () => {});
  const video = container.querySelector("video");
  expect(video).not.toBeNull();
  expect(video?.getAttribute("src")).toBe("blob:video");
  await act(async () => { state.networkAllowed = true; state.listeners.forEach(fn => fn()); });
  await act(async () => { state.networkAllowed = false; state.listeners.forEach(fn => fn()); });
  expect(container.querySelector("video")).toBe(video);
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  await act(async () => { state.allowed = false; state.listeners.forEach(fn => fn()); });
  expect(container.querySelector("video")).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:video");
});

it("keeps the selected native video playing when system reduced motion changes", async () => {
  let reduced = false;
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() { return query === "(prefers-reduced-motion: reduce)" && reduced; },
    addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
  }));
  state.native = true;
  state.id = BACKGROUNDS.find(x => x.kind === "video")!.id;
  const { container } = render(<LivingBackground />);
  await act(async () => {});
  expect(container.querySelectorAll("video")).toHaveLength(1);
  await act(async () => { reduced = true; listeners.forEach(listener => listener()); });
  expect(container.querySelectorAll("video")).toHaveLength(1);
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  await act(async () => { reduced = false; listeners.forEach(listener => listener()); });
  expect(container.querySelectorAll("video")).toHaveLength(1);
});

it("does not mount a late video after motion permission is revoked", async () => {
  let resolve!: (blob: Blob) => void;
  state.download.mockReturnValue(new Promise<Blob>(done => { resolve = done; }));
  state.native = true;
  state.id = BACKGROUNDS.find(x => x.kind === "video")!.id;
  const { container } = render(<LivingBackground />);
  await act(async () => { state.allowed = false; state.listeners.forEach(listener => listener()); });
  await act(async () => resolve(new Blob(["late video"])));
  expect(container.querySelector("video")).toBeNull();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
