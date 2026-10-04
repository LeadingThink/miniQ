// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createAmbientEngine } from "./ambientEngine";
import {
  ambientBackgrounds,
  ambientPalettes,
  ambientStyles,
  ambientThumbStyle,
  getAmbientPalette,
  hashSeed,
} from "./ambientPresets";
import { BACKGROUNDS, isBackgroundId } from "../backgroundCatalog";

/** 2D context stub that accepts any call, so each style really runs in jsdom. */
function stubContext() {
  const calls = { total: 0 };
  const gradient = { addColorStop: () => undefined };
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(obj, key) {
      if (key in obj) return obj[key as string];
      return (..._args: unknown[]) => {
        calls.total += 1;
        return gradient;
      };
    },
    set(obj, key, value) {
      obj[key as string] = value;
      return true;
    },
  });
  return { ctx, calls };
}

function sizedCanvas(ctx: unknown) {
  const canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 640 });
  Object.defineProperty(canvas, "clientHeight", { value: 360 });
  canvas.getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"];
  return canvas;
}

describe("ambient backgrounds", () => {
  it("ships 110 unique, valid presets wired into the background catalog", () => {
    expect(ambientBackgrounds).toHaveLength(ambientStyles.length * ambientPalettes.length);
    expect(ambientBackgrounds).toHaveLength(110);
    const ids = ambientBackgrounds.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = ambientBackgrounds.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
    for (const item of ambientBackgrounds) {
      expect(item.id).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
      expect(item.id).toBe(`ambient-${item.style}-${item.palette}`);
      expect(isBackgroundId(item.id)).toBe(true);
      expect(getAmbientPalette(item.palette)).toBeTruthy();
    }
    const allIds = BACKGROUNDS.map((item) => item.id);
    expect(new Set(allIds).size).toBe(allIds.length);
    const allNames = BACKGROUNDS.map((item) => item.name);
    expect(new Set(allNames).size).toBe(allNames.length);
    expect(BACKGROUNDS.length).toBe(227);
  });

  it("builds gradient thumbnails without image requests", () => {
    const style = ambientThumbStyle("polar");
    expect(style.background).toContain("radial-gradient");
    expect(style.background).not.toContain("url(");
    expect(ambientThumbStyle("missing")).toEqual({});
  });

  it("derives stable seeds", () => {
    expect(hashSeed("ambient-aurora-polar")).toBe(hashSeed("ambient-aurora-polar"));
    expect(hashSeed("ambient-aurora-polar")).not.toBe(hashSeed("ambient-aurora-sakura"));
  });

  it("stays inert when the canvas has no 2D context", () => {
    const canvas = { getContext: () => null, clientWidth: 0, clientHeight: 0 } as unknown as HTMLCanvasElement;
    const engine = createAmbientEngine(canvas, { style: "aurora", palette: ambientPalettes[0], seed: 1 });
    expect(() => {
      engine.resize();
      engine.renderOnce();
      engine.start();
      engine.stop();
      engine.destroy();
    }).not.toThrow();
  });

  it("renders every style in dark and light palettes", () => {
    const light = ambientPalettes.find((item) => "light" in item && item.light)!;
    const dark = ambientPalettes[0];
    for (const style of ambientStyles) {
      for (const palette of [dark, light]) {
        const { ctx, calls } = stubContext();
        const engine = createAmbientEngine(sizedCanvas(ctx), { style: style.id, palette, seed: 7 });
        engine.resize();
        expect(() => engine.renderOnce(), `${style.id}/${palette.id}`).not.toThrow();
        expect(calls.total, `${style.id}/${palette.id}`).toBeGreaterThan(0);
        engine.destroy();
      }
    }
  });

  it("switches presets in place and releases the animation frame on destroy", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 42);
    const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const { ctx } = stubContext();
    const canvas = sizedCanvas(ctx);
    const engine = createAmbientEngine(canvas, { style: "stars", palette: ambientPalettes[0], seed: 3 });
    engine.start();
    expect(raf).toHaveBeenCalled();
    expect(() => engine.setPreset({ style: "rain", palette: ambientPalettes[5], seed: 9 })).not.toThrow();
    engine.destroy();
    expect(caf).toHaveBeenCalledWith(42);
    expect(canvas.width).toBe(1);
    raf.mockRestore();
    caf.mockRestore();
  });
});
