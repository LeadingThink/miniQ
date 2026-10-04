/**
 * Ambient engine: procedural Canvas 2D motion with no image or video requests.
 * Ported from Zaiwen Web (web/src/theme/ambient/ambient-engine.ts).
 * - LivingBackground imports it on demand.
 * - Low cost: capped at 30fps, DPR capped at 1, soft styles render downsampled and CSS scales them up.
 * - One instance switches presets with setPreset; destroy releases rAF and references.
 */
import type { AmbientPalette, AmbientStyle } from "./ambientPresets";

export interface AmbientPreset {
  style: AmbientStyle;
  palette: AmbientPalette;
  /** Layout seed, so one background always opens with the same composition. */
  seed: number;
}

export interface AmbientEngine {
  setPreset(preset: AmbientPreset): void;
  resize(): void;
  start(): void;
  stop(): void;
  renderOnce(): void;
  destroy(): void;
}

interface Scene {
  init(): void;
  frame(t: number, dt: number): void;
}

interface Dot {
  x: number; y: number; vx: number; vy: number; r: number; c: string; p: number; s: number;
}

const FRAME_INTERVAL = 1000 / 30;
/** Soft styles are blurry light, so downsampled rendering looks the same. */
const SOFT_STYLES = new Set<AmbientStyle>(["aurora", "mesh", "bokeh", "waves"]);

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map(ch => ch + ch).join("") : value;
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
}

export function createAmbientEngine(canvas: HTMLCanvasElement, initial: AmbientPreset, options: { lowPower?: boolean } = {}): AmbientEngine {
  const lowPower = options.lowPower === true;
  const frameInterval = lowPower ? 1000 / 15 : FRAME_INTERVAL;
  const ctx = canvas.getContext("2d");
  let preset = initial;
  let W = 1;
  let H = 1;
  let raf = 0;
  let running = false;
  let last = 0;
  let acc = 0;
  let elapsed = 0;
  let rand = mulberry32(preset.seed);
  let scene: Scene | null = null;

  const pick = (list: readonly string[]) => list[Math.floor(rand() * list.length)] ?? list[0] ?? "#ffffff";
  const additive = () => (preset.palette.light ? "source-over" : "lighter") as GlobalCompositeOperation;

  function paintBackdrop(): void {
    if (!ctx) return;
    const [top, bottom] = preset.palette.bg;
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, top);
    grad.addColorStop(1, bottom);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  function dots(count: number, opts: { r: [number, number]; v: number }): Dot[] {
    return Array.from({ length: lowPower ? Math.max(1, Math.round(count * 0.5)) : count }, () => ({
      x: rand() * W,
      y: rand() * H,
      vx: (rand() - 0.5) * opts.v,
      vy: (rand() - 0.5) * opts.v,
      r: opts.r[0] + rand() * (opts.r[1] - opts.r[0]),
      c: pick(preset.palette.colors),
      p: rand() * Math.PI * 2,
      s: 0.5 + rand(),
    }));
  }

  const wrap = (d: Dot, margin: number) => {
    if (d.x < -margin) d.x = W + margin;
    if (d.x > W + margin) d.x = -margin;
    if (d.y < -margin) d.y = H + margin;
    if (d.y > H + margin) d.y = -margin;
  };

  const area = () => (W * H) / (1280 * 720);

  function buildScene(style: AmbientStyle): Scene {
    if (!ctx) return { init() {}, frame() {} };
    const { colors, light } = preset.palette;
    switch (style) {
      case "aurora": {
        let bands: { c: string; y: number; amp: number; f: number; sp: number; ph: number; h: number }[] = [];
        return {
          init() {
            bands = Array.from({ length: lowPower ? 2 : 4 }, (_, i) => ({
              c: colors[i % colors.length]!,
              y: H * (0.22 + i * 0.12 + rand() * 0.05),
              amp: H * (0.05 + rand() * 0.06),
              f: 1.2 + rand() * 1.6,
              sp: 0.06 + rand() * 0.08,
              ph: rand() * 10,
              h: H * (0.16 + rand() * 0.12),
            }));
          },
          frame(t) {
            paintBackdrop();
            ctx.globalCompositeOperation = additive();
            for (const band of bands) {
              const grad = ctx.createLinearGradient(0, band.y - band.h, 0, band.y + band.h);
              grad.addColorStop(0, rgba(band.c, 0));
              grad.addColorStop(0.5, rgba(band.c, light ? 0.32 : 0.42));
              grad.addColorStop(1, rgba(band.c, 0));
              ctx.fillStyle = grad;
              ctx.beginPath();
              const steps = 24;
              for (let i = 0; i <= steps; i += 1) {
                const x = (i / steps) * W;
                const k = i / steps * Math.PI * band.f;
                const y = band.y + Math.sin(k + t * band.sp + band.ph) * band.amp + Math.sin(k * 2.3 - t * band.sp * 0.7) * band.amp * 0.4;
                if (i === 0) ctx.moveTo(x, y - band.h);
                else ctx.lineTo(x, y - band.h);
              }
              for (let i = steps; i >= 0; i -= 1) {
                const x = (i / steps) * W;
                const k = i / steps * Math.PI * band.f;
                const y = band.y + Math.sin(k + t * band.sp + band.ph + 0.6) * band.amp + band.h;
                ctx.lineTo(x, y);
              }
              ctx.closePath();
              ctx.fill();
            }
          },
        };
      }
      case "mesh": {
        let blobs: { c: string; ax: number; ay: number; fx: number; fy: number; ph: number; r: number }[] = [];
        return {
          init() {
            blobs = Array.from({ length: lowPower ? 3 : 5 }, (_, i) => ({
              c: colors[i % colors.length]!,
              ax: 0.25 + rand() * 0.25,
              ay: 0.2 + rand() * 0.25,
              fx: 0.03 + rand() * 0.04,
              fy: 0.025 + rand() * 0.04,
              ph: rand() * 10,
              r: Math.max(W, H) * (0.32 + rand() * 0.2),
            }));
          },
          frame(t) {
            paintBackdrop();
            ctx.globalCompositeOperation = additive();
            for (const blob of blobs) {
              const x = W * (0.5 + Math.sin(t * blob.fx * 6.28 + blob.ph) * blob.ax);
              const y = H * (0.5 + Math.cos(t * blob.fy * 6.28 + blob.ph * 1.3) * blob.ay);
              const grad = ctx.createRadialGradient(x, y, 0, x, y, blob.r);
              grad.addColorStop(0, rgba(blob.c, light ? 0.45 : 0.38));
              grad.addColorStop(1, rgba(blob.c, 0));
              ctx.fillStyle = grad;
              ctx.fillRect(0, 0, W, H);
            }
          },
        };
      }
      case "bokeh": {
        let list: Dot[] = [];
        return {
          init() { list = dots(Math.round(26 * Math.min(2, area()) + 8), { r: [W * 0.02, W * 0.07], v: 6 }); },
          frame(t, dt) {
            paintBackdrop();
            ctx.globalCompositeOperation = additive();
            for (const d of list) {
              d.x += d.vx * dt; d.y += (d.vy - 3) * dt;
              wrap(d, d.r);
              const a = (0.12 + 0.1 * Math.sin(t * 0.5 * d.s + d.p)) * (light ? 1.4 : 1);
              const grad = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, d.r);
              grad.addColorStop(0, rgba(d.c, a * 1.3));
              grad.addColorStop(0.7, rgba(d.c, a));
              grad.addColorStop(1, rgba(d.c, 0));
              ctx.fillStyle = grad;
              ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
            }
          },
        };
      }
      case "fireflies": {
        let list: Dot[] = [];
        return {
          init() { list = dots(Math.round(70 * Math.min(2, area()) + 10), { r: [1.2, 2.8], v: 14 }); },
          frame(t, dt) {
            paintBackdrop();
            ctx.globalCompositeOperation = additive();
            for (const d of list) {
              d.vx += (rand() - 0.5) * 8 * dt; d.vy += (rand() - 0.5) * 8 * dt;
              d.vx *= 0.99; d.vy *= 0.99;
              d.x += d.vx * dt; d.y += d.vy * dt;
              wrap(d, 10);
              const a = Math.max(0, Math.sin(t * 0.9 * d.s + d.p)) * 0.9;
              if (a < 0.02) continue;
              const glow = d.r * (lowPower ? 3 : 6);
              const grad = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, glow);
              grad.addColorStop(0, rgba(d.c, a));
              grad.addColorStop(0.25, rgba(d.c, a * 0.35));
              grad.addColorStop(1, rgba(d.c, 0));
              ctx.fillStyle = grad;
              ctx.fillRect(d.x - glow, d.y - glow, glow * 2, glow * 2);
            }
          },
        };
      }
      case "stars": {
        let list: Dot[] = [];
        let meteor: { x: number; y: number; vx: number; vy: number; life: number } | null = null;
        let nextMeteor = 4;
        return {
          init() { list = dots(Math.round(260 * Math.min(2, area()) + 40), { r: [0.4, 1.6], v: 0 }); nextMeteor = 3 + rand() * 5; },
          frame(t, dt) {
            paintBackdrop();
            ctx.globalCompositeOperation = additive();
            for (const d of list) {
              d.x -= dt * 2 * d.s;
              wrap(d, 2);
              const a = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 1.4 * d.s + d.p));
              ctx.fillStyle = rgba(d.c, a * (light ? 0.8 : 1));
              ctx.fillRect(d.x, d.y, d.r * 1.6, d.r * 1.6);
            }
            nextMeteor -= dt;
            if (!meteor && nextMeteor <= 0) {
              meteor = { x: W * (0.3 + rand() * 0.7), y: H * rand() * 0.4, vx: -W * 0.5, vy: H * 0.25, life: 1 };
              nextMeteor = 6 + rand() * 10;
            }
            if (meteor) {
              meteor.life -= dt * 1.2;
              meteor.x += meteor.vx * dt; meteor.y += meteor.vy * dt;
              const tail = ctx.createLinearGradient(meteor.x, meteor.y, meteor.x - meteor.vx * 0.25, meteor.y - meteor.vy * 0.25);
              tail.addColorStop(0, rgba(colors[0]!, Math.max(0, meteor.life)));
              tail.addColorStop(1, rgba(colors[0]!, 0));
              ctx.strokeStyle = tail; ctx.lineWidth = 1.6;
              ctx.beginPath(); ctx.moveTo(meteor.x, meteor.y);
              ctx.lineTo(meteor.x - meteor.vx * 0.25, meteor.y - meteor.vy * 0.25); ctx.stroke();
              if (meteor.life <= 0) meteor = null;
            }
          },
        };
      }
      case "waves": {
        let layers: { c: string; y: number; amp: number; f: number; sp: number; ph: number }[] = [];
        return {
          init() {
            layers = Array.from({ length: lowPower ? 3 : 5 }, (_, i) => ({
              c: colors[i % colors.length]!,
              y: H * (0.5 + i * 0.1),
              amp: H * (0.03 + rand() * 0.03),
              f: 1.5 + rand() * 2,
              sp: 0.15 + i * 0.05,
              ph: rand() * 10,
            }));
          },
          frame(t) {
            paintBackdrop();
            ctx.globalCompositeOperation = "source-over";
            layers.forEach((layer, i) => {
              ctx.fillStyle = rgba(layer.c, light ? 0.22 + i * 0.05 : 0.16 + i * 0.06);
              ctx.beginPath(); ctx.moveTo(0, H);
              const steps = 32;
              for (let s = 0; s <= steps; s += 1) {
                const x = (s / steps) * W;
                const k = (s / steps) * Math.PI * layer.f;
                ctx.lineTo(x, layer.y + Math.sin(k + t * layer.sp + layer.ph) * layer.amp + Math.sin(k * 2.7 - t * layer.sp) * layer.amp * 0.3);
              }
              ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
            });
          },
        };
      }
      case "rain": {
        let list: Dot[] = [];
        return {
          init() { list = dots(Math.round(140 * Math.min(2, area()) + 20), { r: [8, 22], v: 0 }); for (const d of list) d.vy = H * (0.6 + rand() * 0.5); },
          frame(_t, dt) {
            paintBackdrop();
            ctx.globalCompositeOperation = additive();
            ctx.lineWidth = 1;
            for (const d of list) {
              d.y += d.vy * dt; d.x -= d.vy * 0.12 * dt;
              if (d.y > H + d.r) { d.y = -d.r; d.x = rand() * W * 1.1; }
              ctx.strokeStyle = rgba(d.c, (light ? 0.45 : 0.28) * d.s);
              ctx.beginPath(); ctx.moveTo(d.x, d.y); ctx.lineTo(d.x + d.r * 0.12, d.y - d.r); ctx.stroke();
            }
          },
        };
      }
      case "snow": {
        let list: Dot[] = [];
        return {
          init() { list = dots(Math.round(110 * Math.min(2, area()) + 20), { r: [1, 3.4], v: 0 }); },
          frame(t, dt) {
            paintBackdrop();
            ctx.globalCompositeOperation = "source-over";
            for (const d of list) {
              d.y += (14 + d.r * 9) * dt;
              d.x += Math.sin(t * 0.6 * d.s + d.p) * 12 * dt;
              wrap(d, 6);
              ctx.fillStyle = rgba(d.c, light ? 0.7 : 0.75);
              ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
            }
          },
        };
      }
      case "constellation": {
        let list: Dot[] = [];
        return {
          init() { list = dots(Math.round(42 * Math.min(1.8, area()) + 14), { r: [1.2, 2.4], v: 18 }); },
          frame(_t, dt) {
            paintBackdrop();
            ctx.globalCompositeOperation = "source-over";
            const link = Math.min(W, H) * 0.22;
            const link2 = link * link;
            ctx.lineWidth = 1;
            for (let i = 0; i < list.length; i += 1) {
              const a = list[i]!;
              a.x += a.vx * dt; a.y += a.vy * dt;
              if (a.x < 0 || a.x > W) a.vx *= -1;
              if (a.y < 0 || a.y > H) a.vy *= -1;
              for (let j = i + 1; j < list.length; j += 1) {
                const b = list[j]!;
                const dx = a.x - b.x;
                const dy = a.y - b.y;
                const d2 = dx * dx + dy * dy;
                if (d2 > link2) continue;
                ctx.strokeStyle = rgba(a.c, (1 - d2 / link2) * (light ? 0.5 : 0.35));
                ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
              }
            }
            for (const d of list) {
              ctx.fillStyle = rgba(d.c, 0.9);
              ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2); ctx.fill();
            }
          },
        };
      }
      case "ripples":
      default: {
        let rings: { x: number; y: number; r: number; max: number; c: string }[] = [];
        let spawn = 0;
        return {
          init() { rings = []; spawn = 0; },
          frame(_t, dt) {
            paintBackdrop();
            ctx.globalCompositeOperation = additive();
            spawn -= dt;
            if (spawn <= 0 && rings.length < (lowPower ? 6 : 12)) {
              rings.push({ x: rand() * W, y: rand() * H, r: 0, max: Math.min(W, H) * (0.18 + rand() * 0.25), c: pick(colors) });
              spawn = 0.7 + rand() * 1.1;
            }
            ctx.lineWidth = 1.4;
            rings = rings.filter((ring) => {
              ring.r += dt * ring.max * 0.22;
              const life = 1 - ring.r / ring.max;
              if (life <= 0) return false;
              for (let k = 0; k < 3; k += 1) {
                const r = ring.r - k * ring.max * 0.08;
                if (r <= 0) continue;
                ctx.strokeStyle = rgba(ring.c, life * (light ? 0.55 : 0.45) * (1 - k * 0.3));
                ctx.beginPath(); ctx.ellipse(ring.x, ring.y, r, r * 0.55, 0, 0, Math.PI * 2); ctx.stroke();
              }
              return true;
            });
          },
        };
      }
    }
  }

  function measure(): void {
    const scale = SOFT_STYLES.has(preset.style) ? 0.5 : 1;
    const dpr = Math.min(1, (typeof devicePixelRatio === "number" ? devicePixelRatio : 1) || 1);
    const cssW = canvas.clientWidth || canvas.width || 1;
    const cssH = canvas.clientHeight || canvas.height || 1;
    // Coordinates use CSS pixels; the backing canvas is downsampled by scale.
    W = cssW;
    H = cssH;
    canvas.width = Math.max(1, Math.round(cssW * dpr * scale));
    canvas.height = Math.max(1, Math.round(cssH * dpr * scale));
    ctx?.setTransform(canvas.width / cssW, 0, 0, canvas.height / cssH, 0, 0);
  }

  function rebuild(): void {
    rand = mulberry32(preset.seed);
    measure();
    scene = buildScene(preset.style);
    scene.init();
  }

  function draw(dt: number): void {
    if (!ctx || !scene) return;
    elapsed += dt;
    scene.frame(elapsed, dt);
  }

  function loop(now: number): void {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    if (!last) last = now;
    acc += now - last;
    last = now;
    if (acc < frameInterval) return;
    // Do not replay a long gap after the page returns from the background.
    const dt = Math.min(acc, 100) / 1000;
    acc = 0;
    draw(dt);
  }

  rebuild();

  return {
    setPreset(next) {
      preset = next;
      elapsed = 0;
      rebuild();
      if (!running) draw(0);
    },
    resize() {
      rebuild();
      if (!running) draw(0);
    },
    start() {
      if (running) return;
      running = true;
      last = 0;
      acc = frameInterval;
      raf = requestAnimationFrame(loop);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    renderOnce() {
      // Still frame: advance to a moment with content (fireflies and ripples need time to appear).
      if (!scene) return;
      for (let i = 0; i < 40; i += 1) scene.frame(elapsed += 0.05, 0.05);
    },
    destroy() {
      running = false;
      cancelAnimationFrame(raf);
      scene = null;
      canvas.width = 1;
      canvas.height = 1;
    },
  };
}
