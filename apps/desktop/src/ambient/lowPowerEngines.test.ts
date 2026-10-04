import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAmbientEngine } from "./ambientEngine";
import { ambientPalettes, ambientStyles } from "./ambientPresets";
import { createGlyphEngine } from "../glyph/glyphScenes";

function context() {
  const gradient = () => ({ addColorStop: vi.fn() });
  return {
    fillRect: vi.fn(), drawImage: vi.fn(), arc: vi.fn(), ellipse: vi.fn(),
    beginPath: vi.fn(), closePath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    fill: vi.fn(), stroke: vi.fn(), save: vi.fn(), restore: vi.fn(),
    scale: vi.fn(), setTransform: vi.fn(), fillText: vi.fn(),
    createLinearGradient: vi.fn(gradient), createRadialGradient: vi.fn(gradient),
    measureText: () => ({ width: 100 }), createPattern: () => ({}),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: vi.fn(), shadowBlur: 0,
  };
}
function canvas() {
  const ctx = context();
  const cv = { clientWidth: 800, clientHeight: 600, width: 0, height: 0, getContext: () => ctx };
  return { cv: cv as unknown as HTMLCanvasElement, ctx };
}
let callbacks: Map<number, FrameRequestCallback>;
let offscreen: ReturnType<typeof context>[];
function tick(time: number) {
  const pending = [...callbacks.values()]; callbacks.clear();
  pending.forEach(fn => fn(time));
}
beforeEach(() => {
  callbacks = new Map(); offscreen = []; let id = 0;
  vi.stubGlobal("devicePixelRatio", 3);
  vi.stubGlobal("performance", { now: () => 0 });
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => { callbacks.set(++id, fn); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => callbacks.delete(key));
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", {
    hidden: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    createElement: () => { const c = canvas(); offscreen.push(c.ctx); return c.cv; },
  });
  vi.spyOn(Math, "random").mockReturnValue(0.25);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const preset = { style: "snow" as const, seed: 42, palette: ambientPalettes[0] };
for (const kind of ["ambient", "glyph"] as const) {
  const make = (cv: HTMLCanvasElement, options?: { lowPower?: boolean }) => {
    if (kind === "ambient") return createAmbientEngine(cv, preset, options);
    const engine = createGlyphEngine(cv, options); engine.select("tide"); return engine;
  };
  describe(kind, () => {
    it("caps low-power drawing at 15fps and DPR at 1, including after resize/restart", () => {
      const { cv, ctx } = canvas(); const engine = make(cv, { lowPower: true });
      expect(cv.width).toBe(800); expect(cv.height).toBe(600);
      engine.resize(); expect(cv.width).toBe(800);
      ctx.fillRect.mockClear(); engine.start(); engine.start();
      const times: number[] = [];
      for (let time = 1; time <= 1000; time++) {
        const before = ctx.fillRect.mock.calls.length; tick(time);
        if (ctx.fillRect.mock.calls.length > before) times.push(time);
      }
      expect(times.length).toBeGreaterThan(10); expect(times.length).toBeLessThanOrEqual(15);
      times.slice(1).forEach((time, i) => expect(time - times[i]!).toBeGreaterThanOrEqual(1000 / 15));
      engine.stop(); expect(callbacks.size).toBe(0);
      engine.start(); expect(callbacks.size).toBe(1);
      engine.destroy(); expect(callbacks.size).toBe(0);
    });
    it("preserves default density, DPR and frame rate with explicit false", () => {
      const record = (options?: { lowPower?: boolean }) => {
        const { cv, ctx } = canvas(); const engine = make(cv, options);
        ctx.fillRect.mockClear(); ctx.arc.mockClear(); ctx.drawImage.mockClear();
        engine.start(); for (let time = 1; time <= 1000; time++) tick(time);
        const result = [cv.width, ctx.fillRect.mock.calls.length, ctx.arc.mock.calls.length, ctx.drawImage.mock.calls.length];
        engine.destroy(); return result;
      };
      const baseline = record(); expect(record({ lowPower: false })).toEqual(baseline);
      expect(baseline[0]).toBe(kind === "ambient" ? 800 : 1600);
      expect(baseline[1]).toBeGreaterThan(15);
    });
    it("reduces particle draw calls", () => {
      const count = (lowPower: boolean) => {
        const { cv, ctx } = canvas(); const engine = make(cv, { lowPower });
        ctx.arc.mockClear(); ctx.drawImage.mockClear(); engine.renderOnce();
        const n = ctx.arc.mock.calls.length + ctx.drawImage.mock.calls.length;
        engine.destroy(); return n;
      };
      expect(count(true)).toBeLessThan(count(false) * .6);
    });
  });
}
it("renders every ambient style in both modes and can switch presets", () => {
  for (const lowPower of [false, true]) {
    const { cv } = canvas(); const engine = createAmbientEngine(cv, preset, { lowPower });
    for (const { id: style } of ambientStyles) { engine.setPreset({ ...preset, style }); engine.renderOnce(); }
    engine.destroy();
  }
});
it("renders every glyph scene in both modes and disables low-power atlas blur", () => {
  for (const lowPower of [false, true]) {
    const { cv } = canvas(); const engine = createGlyphEngine(cv, { lowPower });
    offscreen = [];
    for (const scene of engine.scenes) { engine.select(scene.id); engine.renderOnce(); }
    expect(offscreen.length).toBeGreaterThan(0);
    if (lowPower) expect(offscreen.every(ctx => ctx.shadowBlur === 0)).toBe(true);
    else expect(offscreen.some(ctx => ctx.shadowBlur > 0)).toBe(true);
    engine.destroy();
  }
});
