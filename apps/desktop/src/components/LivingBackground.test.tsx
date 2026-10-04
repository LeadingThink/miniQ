// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LivingBackground } from "./LivingBackground";
import { storeBackground } from "../background";
import { BACKGROUNDS } from "../backgroundCatalog";
const state = vi.hoisted(() => ({ native: false, id: "", listeners: new Set<() => void>(), allowed: true }));
vi.mock("../mobileRuntime", () => ({ isNativeMobileApp: () => state.native }));
vi.mock("../mobileBackgroundPolicy", async () => {
  const { getBackground } = await import("../backgroundCatalog");
  return {
    getMobileBackground: () => getBackground(state.id),
    initializeMobileBackgroundPolicy: () => () => {},
    mobileBackgroundPolicy: {
      subscribe: (fn: () => void) => { state.listeners.add(fn); return () => state.listeners.delete(fn); },
      getSnapshot: () => ({ isNative: state.native, canAnimate: state.allowed, canPlayVideo: state.allowed, canDownloadVideo: state.allowed }),
      downloadVideo: async () => new Blob(["video"]),
    },
  };
});
vi.mock("../backgroundVideo", () => ({ loadBackgroundVideo: async () => new Blob(["video"]) }));
beforeEach(() => {
  state.native = false; state.allowed = true;
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
