// Canvas 2D glyph scenes, ported from Zaiwen Web
// (web/src/theme/glyph/glyph-scenes.js). Only createGlyphEngine is exported;
// types live in glyphScenes.d.ts.
/* eslint-disable */
const MONO = '"SF Mono","JetBrains Mono",Menlo,Consolas,monospace';
const SANS = '"PingFang SC","Helvetica Neue",Arial,sans-serif';

export function createGlyphEngine(cv, { lowPower = false } = {}) {
const density = lowPower ? .5 : 1;
const spacing = lowPower ? Math.SQRT2 : 1;
const particleCount = n => lowPower ? Math.max(1, Math.round(n * density)) : n;
const ctx = cv.getContext('2d');
let W = 0, H = 0, DPR = 1;
const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999, nx: .5, ny: .5, lastWave: 0, wx: 0, wy: 0 };

// ---------- 工具 ----------
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const rnd = (a = 1, b) => b === undefined ? Math.random() * a : a + Math.random() * (b - a);
function ramp(stops, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = n === 1 ? 0 : i / (n - 1) * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(u)), f = u - k;
    const c = stops[k].map((v, j) => Math.round(v + (stops[k + 1][j] - v) * f));
    out.push(`rgb(${c.join(',')})`);
  }
  return out;
}
// 字形图集：把所有字符 × 所有颜色预渲染到一张离屏画布，绘制时只做 drawImage（比 fillText 快一个量级）
function makeAtlas(chars, size, colors, { weight = 500, font = MONO, glowIf = () => false, glow = .9, pad = 1.7 } = {}) {
  chars = [...chars];
  const cw = Math.ceil(size * pad), ch = Math.ceil(size * pad);
  const c = document.createElement('canvas');
  c.width = Math.ceil(cw * chars.length * DPR); c.height = Math.ceil(ch * colors.length * DPR);
  const g = c.getContext('2d'); g.scale(DPR, DPR);
  g.font = `${weight} ${size}px ${font}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  colors.forEach((col, j) => {
    g.fillStyle = col;
    if (!lowPower && glowIf(j)) { g.shadowColor = col; g.shadowBlur = size * glow; } else g.shadowBlur = 0;
    chars.forEach((s, i) => g.fillText(s, i * cw + cw / 2, j * ch + ch / 2 + size * .04));
  });
  const sw = cw * DPR, sh = ch * DPR, idx = {};
  chars.forEach((s, i) => idx[s] = i);
  return { chars, idx, n: chars.length, levels: colors.length, size, cw, ch,
    draw(i, j, x, y, s = 1) { i = ((Math.floor(i) % chars.length) + chars.length) % chars.length; j = clamp(Math.round(j), 0, colors.length - 1); const w = cw * s, h = ch * s; ctx.drawImage(c, i * sw, j * sh, sw, sh, x - w / 2, y - h / 2, w, h); } };
}
function h3(x, y, z) {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177); n ^= n >>> 16; return (n >>> 0) / 4294967296;
}
function noise3(x, y, z) {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z);
  let fx = x - X, fy = y - Y, fz = z - Z;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const a = h3(X, Y, Z), b = h3(X + 1, Y, Z), c = h3(X, Y + 1, Z), d = h3(X + 1, Y + 1, Z);
  const e = h3(X, Y, Z + 1), f = h3(X + 1, Y, Z + 1), g = h3(X, Y + 1, Z + 1), h = h3(X + 1, Y + 1, Z + 1);
  const l1 = a + (b - a) * fx, l2 = c + (d - c) * fx, l3 = e + (f - e) * fx, l4 = g + (h - g) * fx;
  const m1 = l1 + (l2 - l1) * fy, m2 = l3 + (l4 - l3) * fy; return m1 + (m2 - m1) * fz;
}
const fbm3 = (x, y, z) => .55 * noise3(x, y, z) + .3 * noise3(x * 2.03 + 7, y * 2.03, z * 2.03) + .15 * noise3(x * 4.1, y * 4.1 + 3, z * 4.1);
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

// ================= 1. 字节升腾 =================
const S_bytes = {
  id: 'bytes', name: '字节升腾', light: false,
  desc: '十六进制字节从屏幕底部的光源里升起，分远中近三层景深，越往上越淡、最后溶进黑暗。偶尔有一条紫色“数据包”混在里面。',
  init() {
    const CH = '0123456789ABCDEF0123456789abcdef<>/{}[]#*+=λΣΔ∂';
    const pal = [...ramp([[4, 14, 34], [8, 40, 90], [14, 110, 170], [40, 190, 235], [150, 240, 255], [245, 255, 255]], 14),
                 ...ramp([[24, 8, 50], [90, 36, 170], [180, 110, 255], [245, 225, 255]], 8)];
    const glowIf = j => (j >= 10 && j < 14) || j >= 19;
    this.layers = [
      { size: 9, sp: [26, 60], a: .42, gap: 1.05, fill: .6 },
      { size: 13, sp: [55, 120], a: .78, gap: 1.12, fill: .5 },
      { size: 20, sp: [100, 190], a: 1, gap: 1.3, fill: .13 },
    ].map(L => {
      L.at = makeAtlas(CH, L.size, pal, { glowIf, glow: 1.1 }); L.lh = L.size * 1.18;
      const cols = Math.ceil(W / (L.size * L.gap)); L.streams = [];
      for (let i = 0; i < cols; i++) if (Math.random() < L.fill * density) L.streams.push(this.spawn(L, (i + .5) * L.size * L.gap, true));
      return L;
    });
  },
  spawn(L, x, pre) {
    const len = 8 + Math.random() * 30 | 0;
    return { x, len, acc: Math.random() < .06, v: rnd(L.sp[0], L.sp[1]),
      y: pre ? Math.random() * (H + len * L.lh) - len * L.lh * .3 : H + Math.random() * H * .7,
      c: Array.from({ length: len }, () => Math.random() * L.at.n | 0) };
  },
  frame(t, dt) {
    const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#010207'); g.addColorStop(1, '#03101f');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    const rg = ctx.createRadialGradient(W * .5, H * 1.1, 0, W * .5, H * 1.1, H * .85);
    rg.addColorStop(0, 'rgba(40,170,255,.38)'); rg.addColorStop(.45, 'rgba(20,80,180,.12)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = rg; ctx.fillRect(0, 0, W, H);
    const lg = ctx.createLinearGradient(0, 0, W, 0);
    lg.addColorStop(0, 'rgba(80,200,255,0)'); lg.addColorStop(.5, 'rgba(160,235,255,.55)'); lg.addColorStop(1, 'rgba(80,200,255,0)');
    ctx.fillStyle = lg; ctx.fillRect(0, H - 1.5, W, 1.5);
    for (const L of this.layers) {
      for (const s of L.streams) {
        s.y -= s.v * dt;
        if (s.y + s.len * L.lh < -20) { Object.assign(s, this.spawn(L, s.x, false)); continue; }
        const md = s.x - mouse.x, boost = Math.exp(-md * md / 6000) * .35;
        for (let k = 0; k < s.len; k++) {
          const y = s.y + k * L.lh; if (y < -L.lh || y > H + L.lh) continue;
          if (Math.random() < .015) s.c[k] = Math.random() * L.at.n | 0;
          const f = k / s.len;
          let lv = k === 0 ? 13 : Math.round(Math.pow(1 - f, 1.5) * 11);
          if (s.acc) lv = 14 + Math.round(lv / 13 * 7);
          const fade = Math.pow(clamp(y / (H * .55), 0, 1), .8);
          ctx.globalAlpha = Math.min(1, L.a * fade * (k === 0 ? 1 : .3 + .7 * (1 - f)) + boost * fade);
          L.at.draw(s.c[k], lv, s.x, y);
        }
      }
    }
  },
};

// ================= 2. 字符星球 =================
const S_globe = {
  id: 'globe', name: '字符星球', light: false,
  desc: '一颗完全由 ASCII 字符“画”出来的星球：大陆是 #%@，海洋是 .:，经纬线是点阵，外圈两条十六进制字符环绕行。鼠标可以轻微转动它。',
  init() {
    this.fs = Math.max(10, Math.round(Math.min(W, H) / 78)); this.cw = this.fs * .62 * spacing; this.chh = this.fs * 1.08 * spacing;
    this.cols = Math.ceil(W / this.cw); this.rows = Math.ceil(H / this.chh);
    this.RAMP = ' .,:;-=+*#%@';
    const pal = [...ramp([[12, 44, 66], [20, 120, 150], [60, 210, 230], [225, 255, 255]], 10),
                 ...ramp([[10, 18, 44], [20, 44, 100], [44, 86, 175]], 6),
                 'rgb(100,90,220)', 'rgb(180,165,255)',
                 ...ramp([[70, 34, 10], [220, 140, 60], [255, 232, 185]], 5)];
    this.at = makeAtlas(this.RAMP + '0123456789ABCDEF·', this.fs, pal, { weight: 600, glowIf: j => j === 8 || j === 9 || j === 17 || j >= 21 });
    this.rings = [{ r: 1.5, inc: .42, sp: .2, n: particleCount(230), a: 1 }, { r: 1.82, inc: -.22, sp: -.11, n: particleCount(280), a: .55 }];
    this.rc = Array.from({ length: 600 }, () => this.at.idx['0123456789ABCDEF'[Math.random() * 16 | 0]]);
    this.stars = Array.from({ length: particleCount(160) }, () => ({ x: rnd(W), y: rnd(H), c: this.at.idx[['.', '·', '+'][Math.random() * 3 | 0]], ph: rnd(6.28) }));
  },
  frame(t) {
    ctx.fillStyle = '#020308'; ctx.fillRect(0, 0, W, H);
    const A = this.at, cw = this.cw, chh = this.chh, RAMP = this.RAMP, I = A.idx;
    const cx = W * .5, cy = H * .52, R = Math.min(W * .3, H * .35);
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(cx, cy, R * .7, cx, cy, R * 2.3);
    g.addColorStop(0, 'rgba(30,110,200,.16)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    for (const s of this.stars) { ctx.globalAlpha = .18 + .2 * Math.sin(t * 1.3 + s.ph); A.draw(s.c, 12, s.x, s.y, .8); }
    const rot = t * .1 + (mouse.nx - .5) * .8, tilt = .38 + (mouse.ny - .5) * .3;
    const cr = Math.cos(rot), sr = Math.sin(rot), ct = Math.cos(tilt), st = Math.sin(tilt);
    const Lx = -.55, Ly = .55, Lz = .63, P12 = Math.PI / 12, bandY = Math.sin(t * .35) * .9;
    const r0 = Math.max(0, Math.floor((cy - R * 1.25) / chh)), r1 = Math.min(this.rows, Math.ceil((cy + R * 1.25) / chh));
    const c0 = Math.max(0, Math.floor((cx - R * 1.25) / cw)), c1 = Math.min(this.cols, Math.ceil((cx + R * 1.25) / cw));
    const tq = (t * 3) | 0;
    for (let r = r0; r < r1; r++) {
      const y = (r + .5) * chh, dy = (cy - y) / R;
      for (let c = c0; c < c1; c++) {
        const x = (c + .5) * cw, dx = (x - cx) / R, d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          const nz = Math.sqrt(1 - d2);
          let lam = dx * Lx + dy * Ly + nz * Lz; lam = lam > 0 ? lam : 0;
          const y1 = dy * ct - nz * st, z1 = dy * st + nz * ct;
          const x2 = dx * cr + z1 * sr, z2 = -dx * sr + z1 * cr;
          const n = fbm3(x2 * 1.9 + 5, y1 * 1.9, z2 * 1.9);
          const lat = Math.asin(clamp(y1, -1, 1)), lon = Math.atan2(x2, z2);
          const la = lat / P12, lo = lon / P12;
          const gl = Math.abs(la - Math.round(la)) < .07 || Math.abs(lo - Math.round(lo)) < .05 / Math.max(.25, Math.cos(lat));
          const rim = (1 - nz) * (1 - nz), band = Math.exp(-(y1 - bandY) * (y1 - bandY) * 60);
          if (n > .54) {
            const v = Math.min(1, .12 + lam * .85 + rim * .25 + band * .35);
            ctx.globalAlpha = 1; A.draw(I[RAMP[3 + Math.round(v * 8)]], Math.round(v * 9), x, y);
          } else if (gl) {
            ctx.globalAlpha = Math.min(1, .3 + .5 * lam + .4 * rim + band * .5); A.draw(I['·'], band > .3 ? 17 : 16, x, y);
          } else {
            const v = lam * .7 + rim * .45 + band * .35; if (v < .08) continue;
            ctx.globalAlpha = .85; A.draw(I[RAMP[1 + Math.min(4, Math.round(v * 3))]], 10 + Math.min(5, Math.round(v * 5)), x, y);
          }
        } else if (d2 < 1.5) {
          const a = 1 - (Math.sqrt(d2) - 1) / .2247;
          if (h3(c, r, tq) < a * a * .35) { ctx.globalAlpha = a * .7; A.draw(I['.'], 4, x, y); }
        }
      }
    }
    let k = 0;
    for (const rg of this.rings) {
      const ci = Math.cos(rg.inc), si = Math.sin(rg.inc);
      for (let i = 0; i < rg.n; i++, k++) {
        const th = i / rg.n * Math.PI * 2 + t * rg.sp;
        const px = Math.cos(th) * rg.r, pz0 = Math.sin(th) * rg.r, py = pz0 * si * .55, pz = pz0 * ci;
        if (pz < 0 && px * px + py * py < 1) continue;
        if (Math.random() < .01) this.rc[k] = I['0123456789ABCDEF'[Math.random() * 16 | 0]];
        const dep = (pz / rg.r + 1) / 2;
        ctx.globalAlpha = (.2 + .8 * dep) * rg.a;
        A.draw(this.rc[k], 18 + Math.round(dep * 4), cx + px * R, cy - py * R, .75 + dep * .45);
      }
    }
  },
};

// ================= 3. 数字海洋（黑金） =================
const S_sea = {
  id: 'sea', name: '数字海洋', light: false,
  desc: '黑金配色。一片由数字组成的透视海面，每个数字就是那一点的“浪高”(0–9)，浪尖亮、浪谷暗，向镜头缓缓涌来。数据即风景。',
  init() {
    this.at = makeAtlas('0123456789', 24, ramp([[34, 20, 4], [95, 60, 14], [180, 125, 40], [245, 200, 110], [255, 246, 225]], 12),
      { weight: 500, glowIf: j => j >= 9, glow: .6, pad: 2.6 });
  },
  frame(t) {
    const hy = H * .36;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#000'); g.addColorStop(hy / H, '#170e03'); g.addColorStop(1, '#040302');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    const sg = ctx.createRadialGradient(W * .5, hy, 0, W * .5, hy, W * .45);
    sg.addColorStop(0, 'rgba(255,190,90,.30)'); sg.addColorStop(.25, 'rgba(200,120,40,.10)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sg; ctx.fillRect(0, 0, W, H);
    const lg = ctx.createLinearGradient(0, 0, W, 0);
    lg.addColorStop(0, 'rgba(255,200,120,0)'); lg.addColorStop(.5, 'rgba(255,220,160,.7)'); lg.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = lg; ctx.fillRect(0, hy - .5, W, 1);
    const A = this.at, f = H * .35, camH = 2.1, rows = particleCount(54), zN = 1.1, zF = 30, dz = (zF - zN) / rows, v = 1.2;
    const off = (t * v) % dz, glyphW = A.size * .6, dxw = .42;
    for (let i = rows - 1; i >= 0; i--) {
      const z = zN + i * dz - off; if (z < .7) continue;
      const sc = f / z, wz = z + t * v;
      const fog = Math.pow(clamp(1 - (z - zN) / (zF - zN), 0, 1), 1.2);
      const stride = dxw * Math.max(1, Math.ceil(5 / (dxw * sc)));
      const hw = (W / 2) / sc + 1, x0 = Math.floor(-hw / stride) * stride;
      const ds = (stride * sc * .82) / glyphW;
      for (let x = x0; x <= hw; x += stride) {
        const h = .55 * Math.sin(x * .35 + wz * .25 + t * .4) + .35 * Math.sin(x * .9 - wz * .5 + t * .9) * Math.cos(wz * .18)
                + .2 * Math.sin((x + wz) * 1.3 - t * 1.4);
        const hn = clamp((h + 1.1) / 2.2, 0, .999);
        const sx = W / 2 + x * sc, sy = hy + (camH - h * .7) * sc;
        if (sy > H + 30) continue;
        ctx.globalAlpha = fog * (.18 + .82 * hn);
        A.draw(hn * 10 | 0, Math.round(Math.pow(hn, 1.6) * 11), sx, sy, Math.min(ds, 2.2));
      }
    }
  },
};

// ================= 4. 字符聚合 =================
const S_morph = {
  id: 'morph', name: '字符聚合', light: false,
  desc: '微小代码字符缓慢聚合成环面、双螺旋与波纹曲面，随后轻轻散开。没有大字标题，只有抽象结构在呼吸。',
  init() {
    const pal = [...ramp([[18, 36, 84], [40, 120, 220], [90, 220, 255], [235, 255, 255]], 8),
                 ...ramp([[40, 20, 90], [140, 80, 255], [242, 205, 255]], 5)];
    this.at = makeAtlas('01<>/{}[]λΣ#*+=ABCDEF', 11, pal, { weight: 600, glowIf: j => j === 7 || j === 12 });
    const n = particleCount(Math.round(Math.min(3400, W * H / 400)));
    this.ps = Array.from({ length: n }, () => ({ x: rnd(W), y: rnd(H), vx: 0, vy: 0, tx: 0, ty: 0, on: false,
      c: Math.random() * this.at.n | 0, ph: rnd(6.28), acc: Math.random() < .2 }));
    this.words = ['torus', 'helix', 'wave'];
    this.wi = 0; this.T0 = null; this.dispersed = false; this.snap = true;
  },
  sample(shape) {
    const pts = [], n = Math.floor(this.ps.length * .75), R = Math.min(W,H) * .27;
    for (let i=0;i<n;i++) {
      const u=i/n*Math.PI*2, v=i*2.399963;
      let x,y;
      if (shape === 'torus') { const r=R*(.78+.2*Math.cos(v)); x=Math.cos(u)*r; y=Math.sin(u)*r*.42+Math.sin(v)*R*.16; }
      else if (shape === 'helix') { const q=i/n; x=(q-.5)*R*2.4; y=Math.sin(q*Math.PI*5+(i%2)*Math.PI)*R*.32+Math.cos(v)*R*.045; }
      else { const q=(i%53)/52, z=Math.floor(i/53)/Math.ceil(n/53); x=(q-.5)*R*2.6; y=(z-.5)*R*.75+Math.sin(q*7+z*4)*R*.19; }
      pts.push([W*.5+x,H*.48+y]);
    }
    return shuffle(pts);
  },
  setWord() {
    const pts = this.sample(this.words[this.wi % this.words.length]); shuffle(this.ps);
    const m = Math.min(pts.length, Math.floor(this.ps.length * .88));
    this.ps.forEach((p, k) => {
      if (k < m) { p.tx = pts[k][0]; p.ty = pts[k][1]; p.on = true;
        if (this.snap) { p.x = p.tx + rnd(-25, 25); p.y = p.ty + rnd(-25, 25); } }
      else p.on = false;
    });
    this.snap = false;
  },
  frame(t, dt) {
    if (this.T0 === null) { this.T0 = t - 1.6; this.setWord(); }
    let u = t - this.T0;
    if (u > 8.6) { this.wi++; this.T0 = t; u = 0; this.dispersed = false; this.setWord(); }
    if (u > 5.4 && !this.dispersed) {
      this.dispersed = true;
      for (const p of this.ps) if (p.on) { p.on = false; p.vx += (p.x - W / 2) * .006 + rnd(-1.5, 1.5); p.vy += (p.y - H / 2) * .006 + rnd(-1.5, 1.5); }
    }
    ctx.fillStyle = '#03040a'; ctx.fillRect(0, 0, W, H);
    const bg = ctx.createRadialGradient(W / 2, H * .47, 0, W / 2, H * .47, W * .55);
    bg.addColorStop(0, 'rgba(30,60,140,.16)'); bg.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';
    const k = dt * 60, damp = Math.pow(.88, k), fdamp = Math.pow(.965, k);
    const sweep = ((u - 1.6) / 2.4) * W * 1.3 - W * .15;
    for (const p of this.ps) {
      if (p.on) {
        p.vx = (p.vx + (p.tx - p.x) * .012 * k) * damp; p.vy = (p.vy + (p.ty - p.y) * .012 * k) * damp;
      } else {
        const a = Math.sin(p.x * .0028 + t * .2) * 1.6 + Math.cos(p.y * .0034 - t * .15) * 1.4 + Math.sin((p.x + p.y) * .0015) * 1.2;
        p.vx = (p.vx + Math.cos(a) * .05 * k) * fdamp; p.vy = (p.vy + Math.sin(a) * .05 * k) * fdamp;
      }
      const mx = p.x - mouse.x, my = p.y - mouse.y, md2 = mx * mx + my * my;
      if (md2 < 16900 && md2 > 1) { const d = Math.sqrt(md2), f = (1 - d / 130) * 1.8 * k; p.vx += mx / d * f; p.vy += my / d * f; }
      p.x += p.vx * k; p.y += p.vy * k;
      if (!p.on) { if (p.x < -10) p.x += W + 20; else if (p.x > W + 10) p.x -= W + 20; if (p.y < -10) p.y += H + 20; else if (p.y > H + 10) p.y -= H + 20; }
      if (Math.random() < 1-Math.exp(-dt*.72)) p.c = Math.random() * this.at.n | 0;
      let lv, al;
      if (p.on) {
        const sw = Math.exp(-((p.x - sweep) ** 2) / 3000);
        lv = sw > .5 ? 7 : 4 + ((p.ph * 7) | 0) % 3; al = .75 + .25 * Math.sin(t * 3 + p.ph) * .5 + sw * .3;
      } else { lv = 1 + ((p.ph * 5) | 0) % 2; al = .5; }
      if (p.acc) lv = 8 + Math.round(lv / 7 * 4);
      ctx.globalAlpha = Math.min(1, al) * .52; this.at.draw(p.c, lv, p.x, p.y);
    }
  },
};

// ================= 5. 解码矩阵 =================
const S_decode = {
  id: 'decode', name: '解码矩阵', light: false,
  desc: '满屏是暗淡的乱码，一圈圈“解码波”扫过时字符先乱跳、再显出底下真正的代码。整屏乱码中隐约拼出巨大的 ZAIWEN。鼠标划过也会触发解码。',
  init() {
    this.fs = 13; this.cw = 10 * spacing; this.chh = 20 * spacing;
    this.cols = Math.ceil(W / this.cw); this.rows = Math.ceil(H / this.chh);
    let A = ''; for (let i = 33; i < 127; i++) A += String.fromCharCode(i);
    const pal = [...ramp([[18, 24, 34], [62, 76, 98]], 5), ...ramp([[20, 90, 110], [60, 200, 230], [170, 250, 255]], 6), ...ramp([[210, 245, 255], [255, 255, 255]], 3)];
    this.at = makeAtlas(A, this.fs, pal, { weight: 500, glowIf: j => j >= 11 });
    const SRC = '/* zaiwen.ai - ask anything */ const ctx = await retrieve(query, { topK: 8, rerank: true }); for await (const token of model.stream(ctx)) { ui.render(token); } if (answer.confidence < 0.6) search.deep(query); ';
    const N = this.cols * this.rows;
    this.tgt = new Int16Array(N); this.cur = new Int16Array(N); this.E = new Float32Array(N); this.mask = new Uint8Array(N); this.hs = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const ch = SRC[i % SRC.length]; this.tgt[i] = ch === ' ' ? -1 : A.indexOf(ch);
      this.cur[i] = Math.random() * A.length | 0; this.hs[i] = Math.random();
    }
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d', { willReadFrequently: true });
    let fs = H * .42; g.font = `900 ${fs}px "Helvetica Neue",Arial,sans-serif`; const w = g.measureText('ZAIWEN').width; if (w > W * .82) fs *= W * .82 / w;
    g.font = `900 ${fs}px "Helvetica Neue",Arial,sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff'; g.fillText('ZAIWEN', W / 2, H * .5);
    const d = g.getImageData(0, 0, W, H).data;
    for (let r = 0; r < this.rows; r++) for (let cc = 0; cc < this.cols; cc++) {
      const x = Math.min(W - 1, (cc + .5) * this.cw | 0), y = Math.min(H - 1, (r + .5) * this.chh | 0);
      this.mask[r * this.cols + cc] = d[(y * W + x) * 4 + 3] > 128 ? 1 : 0;
    }
    this.waves = [{ x: W * .3, y: H * .6, t0: -1.2, sp: 420, s: 1 }, { x: W * .75, y: H * .3, t0: -.4, sp: 480, s: 1 }];
    this.next = 0;
  },
  frame(t, dt) {
    ctx.fillStyle = '#05070b'; ctx.fillRect(0, 0, W, H);
    const A = this.at, cols = this.cols, cw = this.cw, chh = this.chh, diag = Math.hypot(W, H);
    if (t > this.next) { this.waves.push({ x: rnd(W), y: rnd(H), t0: t, sp: rnd(380, 560), s: 1 }); this.next = t + rnd(1.3, 2.2); }
    if (mouse.x > -9000 && Math.hypot(mouse.x - mouse.wx, mouse.y - mouse.wy) > 70 && t - mouse.lastWave > .12) {
      this.waves.push({ x: mouse.x, y: mouse.y, t0: t, sp: 320, s: .7, max: 220 }); mouse.wx = mouse.x; mouse.wy = mouse.y; mouse.lastWave = t;
    }
    this.waves = this.waves.filter(w => (t - w.t0) * w.sp < (w.max || diag) + 40);
    const scanY = (t * 70) % (H + 300) - 150, decay = Math.pow(.06, dt);
    ctx.globalCompositeOperation = 'lighter';
    for (let r = 0; r < this.rows; r++) {
      const y = (r + .5) * chh;
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c, x = (c + .5) * cw;
        let e = this.E[i] * decay;
        for (const w of this.waves) {
          const rr = (t - w.t0) * w.sp, lim = w.max || diag;
          const dd = Math.abs(Math.hypot(x - w.x, y - w.y) - rr);
          if (dd < 32) { const v = (1 - dd / 32) * w.s * (1 - rr / lim * .7); if (v > e) e = v; }
        }
        const sd = Math.abs(y - scanY); if (sd < 12) e = Math.max(e, .3 * (1 - sd / 12));
        this.E[i] = e;
        const tg = this.tgt[i], m = this.mask[i];
        if (e > .55) {
          if (Math.random() < .5) this.cur[i] = Math.random() * A.n | 0;
          ctx.globalAlpha = 1; A.draw(this.cur[i], 11 + Math.min(2, (e - .55) * 6.6 | 0), x, y);
        } else if (e > .08 && tg >= 0) {
          ctx.globalAlpha = .35 + e; A.draw(tg, 5 + Math.min(5, (e / .55 * 5) | 0) + (m ? 1 : 0), x, y);
        } else if (m) {
          if (tg >= 0) { ctx.globalAlpha = .32 + .1 * Math.sin(t * 1.5 + this.hs[i] * 6); A.draw(tg, 5, x, y); }
        } else if (this.hs[i] < .55) {
          if (Math.random() < .003) this.cur[i] = Math.random() * A.n | 0;
          ctx.globalAlpha = .55; A.draw(this.cur[i], 1 + (this.hs[i] * 7 | 0) % 3, x, y);
        }
      }
    }
  },
};

// ================= 6. 语义星云（浅色） =================
const S_tokens = {
  id: 'tokens', name: '语义星云', light: true,
  desc: '浅色杂志风。数百个字符和词元（推理、embedding、注意力、∑…）分布在一个缓慢旋转的球面上，近大远小；蓝色“注意力脉冲”沿连线在词之间传递，被点亮的词会变蓝。',
  init() {
    const words = ['推理', 'token', 'embedding', '注意力', '上下文', '向量', '∑', 'λ', '检索', '生成', '语义', 'attention', 'transformer',
      '0x7F', '在问', '思考', '知识', '模型', 'context', 'prompt', '对话', '逻辑', '概率', '梯度', '∂L/∂w', 'softmax', 'RAG', 'agent',
      '记忆', '规划', '多模态', '图像', '代码', '搜索', '引用', '答案', 'query', 'reason', '∞', '≈', '→', 'logits', '采样', '温度',
      'layer[32]', '权重', 'KV cache', '对齐', '幻觉', '证据', 'π', 'Δ', '翻译', '总结', 'vision', '长文本', 'f(x)', '0.97'];
    const N = particleCount(420), step = Math.floor(N / words.length);
    const GL = '01abcdef<>{}·+=';
    this.nodes = Array.from({ length: N }, (_, i) => {
      const y = 1 - 2 * (i + .5) / N, r = Math.sqrt(1 - y * y), ph = i * 2.39996;
      return { p: [Math.cos(ph) * r, y, Math.sin(ph) * r], w: null, ch: GL[Math.random() * GL.length | 0], hot: 0 };
    });
    this.wn = [];
    words.forEach((w, k) => { const nd = this.nodes[(k * step + (k * 7) % step) % N]; nd.w = w; nd.cjk = /[\u4e00-\u9fa5]/.test(w); this.wn.push(nd); });
    const d3 = (a, b) => (a.p[0] - b.p[0]) ** 2 + (a.p[1] - b.p[1]) ** 2 + (a.p[2] - b.p[2]) ** 2;
    const set = new Set(); this.edges = []; this.adj = new Map(this.wn.map(n => [n, []]));
    for (const a of this.wn) {
      const near = this.wn.filter(b => b !== a).sort((x, y) => d3(a, x) - d3(a, y)).slice(0, 3);
      for (const b of near) {
        const key = [this.wn.indexOf(a), this.wn.indexOf(b)].sort((x, y) => x - y).join('-');
        if (set.has(key)) continue; set.add(key);
        const e = [a, b]; this.edges.push(e); this.adj.get(a).push([e, b]); this.adj.get(b).push([e, a]);
      }
    }
    this.pulses = Array.from({ length: particleCount(14) }, () => { const e = this.edges[Math.random() * this.edges.length | 0]; return { a: e[0], b: e[1], u: Math.random() }; });
    const gc = document.createElement('canvas'); gc.width = gc.height = 180; const gg = gc.getContext('2d'); const id = gg.createImageData(180, 180);
    for (let i = 0; i < id.data.length; i += 4) { const v = Math.random() * 255 | 0; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 10; }
    gg.putImageData(id, 0, 0); this.grain = ctx.createPattern(gc, 'repeat');
    // 预渲染：散点字形图集 + 每个词的灰/蓝两张精灵，避免每帧切换 font（Chrome 下非常慢）
    this.gat = makeAtlas(GL, 22, ['#1e2433'], { weight: 400 });
    const SZ = 40;
    const sprite = (w, cjk, col) => {
      const f = `600 ${SZ}px ${cjk ? SANS : MONO}`;
      const m = document.createElement('canvas').getContext('2d'); m.font = f;
      const tw = Math.ceil(m.measureText(w).width) + 8, th = Math.ceil(SZ * 1.4);
      const c = document.createElement('canvas'); c.width = tw * DPR; c.height = th * DPR;
      const g = c.getContext('2d'); g.scale(DPR, DPR); g.font = f; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = col;
      g.fillText(w, tw / 2, th / 2); return { c, w: tw / SZ, h: th / SZ };
    };
    for (const n of this.wn) { n.sp = sprite(n.w, n.cjk, '#1a1f2c'); n.spHot = sprite(n.w, n.cjk, '#2f5bff'); }
  },
  frame(t, dt) {
    ctx.fillStyle = '#f2f0eb'; ctx.fillRect(0, 0, W, H);
    const lg = ctx.createRadialGradient(W * .3, H * .15, 0, W * .3, H * .15, W * .7);
    lg.addColorStop(0, 'rgba(255,255,255,.85)'); lg.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = lg; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = this.grain; ctx.fillRect(0, 0, W, H);
    const ry = t * .07 + (mouse.nx - .5) * .6, rx = .28 + (mouse.ny - .5) * .4;
    const cy_ = Math.cos(ry), sy_ = Math.sin(ry), cx_ = Math.cos(rx), sx_ = Math.sin(rx);
    const R = Math.min(W, H) * .42, CX = W * .5, CY = H * .5;
    const proj = (p, o) => {
      const x1 = p[0] * cy_ + p[2] * sy_, z1 = -p[0] * sy_ + p[2] * cy_;
      const y1 = p[1] * cx_ - z1 * sx_, z2 = p[1] * sx_ + z1 * cx_;
      const s = 3 / (3 - z2); o.sx = CX + x1 * R * s; o.sy = CY - y1 * R * s; o.s = s; o.d = (z2 + 1) / 2; return o;
    };
    // 两条大圆轨道
    ctx.lineWidth = .7;
    for (const [ax, tilt] of [[0, 0], [1, .9]]) {
      ctx.beginPath();
      for (let i = 0; i <= 120; i++) {
        const a = i / 120 * Math.PI * 2; let p = ax ? [Math.cos(a), Math.sin(a) * Math.cos(tilt), Math.sin(a) * Math.sin(tilt)] : [Math.cos(a), 0, Math.sin(a)];
        const o = proj(p, {}); i ? ctx.lineTo(o.sx, o.sy) : ctx.moveTo(o.sx, o.sy);
      }
      ctx.strokeStyle = 'rgba(20,26,40,.07)'; ctx.stroke();
    }
    for (const n of this.nodes) proj(n.p, n);
    for (const [a, b] of this.edges) {
      ctx.globalAlpha = .05 + .16 * Math.min(a.d, b.d); ctx.strokeStyle = '#1a2030';
      ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const p of this.pulses) {
      p.u += dt * .45;
      if (p.u >= 1) { p.b.hot = 1; const nx = this.adj.get(p.b); const pick = nx[Math.random() * nx.length | 0]; p.a = p.b; p.b = pick[1]; p.u = 0; }
      const x = p.a.sx + (p.b.sx - p.a.sx) * p.u, y = p.a.sy + (p.b.sy - p.a.sy) * p.u, d = Math.min(p.a.d, p.b.d);
      ctx.globalAlpha = .35 + .65 * d; ctx.shadowColor = 'rgba(47,91,255,.8)'; ctx.shadowBlur = lowPower ? 0 : 10;
      ctx.fillStyle = '#2f5bff'; ctx.beginPath(); ctx.arc(x, y, 1.6 + 1.6 * d, 0, 6.29); ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const GA = this.gat;
    for (const n of this.nodes) {
      if (n.w) continue;
      ctx.globalAlpha = .07 + .32 * n.d * n.d;
      GA.draw(GA.idx[n.ch], 0, n.sx, n.sy, (8 + 3 * n.d) * n.s / 22);
    }
    const ws = [...this.wn].sort((a, b) => a.d - b.d);
    for (const n of ws) {
      n.hot = Math.max(0, n.hot - dt * .5);
      const sz = (11 + 8 * n.d) * n.s, a = .12 + .88 * Math.pow(n.d, 1.6);
      const w = n.sp.w * sz, h = n.sp.h * sz, x = n.sx - w / 2, y = n.sy - h / 2;
      ctx.globalAlpha = a * (1 - n.hot); ctx.drawImage(n.sp.c, x, y, w, h);
      if (n.hot > .02) { ctx.globalAlpha = Math.max(a, .5) * n.hot; ctx.drawImage(n.spHot.c, x, y, w, h); }
    }
  },
};

// ================= 7. 字符瀑布 =================
const S_fountain = {
  id: 'fountain', name: '字符瀑布', light: false,
  desc: '从底部光源向上生长的字符瀑布：中文、数学符号与十六进制片段在暗场里聚散，像一台正在醒来的未来机器。',
  init() {
    const chars = '在问AI·∞∑λΔ∂⌘◌◈◇▹0123456789ABCDEF{}[]<>/';
    this.at = makeAtlas(chars, 15, ramp([[8,28,60],[18,106,155],[80,220,235],[230,255,255]], 14), { weight: 600, glowIf: i => i > 18 });
    this.cols = Array.from({length: Math.ceil(W/(18 * spacing))+2}, (_,i) => ({ x:i*18*spacing+rnd(-3,3), y:rnd(-H*.3,H), v:rnd(18,48), len:4+rnd(13)|0, phase:rnd(6.28), seed:rnd(1000) }));
    this.bursts = Array.from({length:particleCount(20)},()=>({x:rnd(W), y:rnd(H*.45,H), r:rnd(2,9), a:rnd(6.28)}));
  },
  frame(t,dt) {
    const g=ctx.createLinearGradient(0,0,0,H); g.addColorStop(0,'#010209'); g.addColorStop(.72,'#030916'); g.addColorStop(1,'#071b2b'); ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
    ctx.globalCompositeOperation='lighter';
    const rg=ctx.createRadialGradient(W*.5,H*1.08,0,W*.5,H*1.08,H*.88); rg.addColorStop(0,'rgba(43,190,255,.42)'); rg.addColorStop(.34,'rgba(25,100,190,.12)'); rg.addColorStop(1,'rgba(0,0,0,0)'); ctx.fillStyle=rg; ctx.fillRect(0,0,W,H);
    for(const b of this.bursts){ b.r+=dt*(2+Math.sin(b.a)*1.5); b.a+=dt; if(b.r>22){b.r=rnd(2,8);b.x=rnd(W);b.y=rnd(H*.5,H)} ctx.globalAlpha=.12*(1-b.r/22); ctx.strokeStyle='#5ee9ff'; ctx.beginPath();ctx.arc(b.x,b.y,b.r,0,6.28);ctx.stroke(); }
    for(const s of this.cols){ s.y-=s.v*dt; if(s.y+s.len*18<-30){s.y=H+rnd(0,100);s.v=rnd(18,48)} const lean=Math.sin(t*.45+s.phase)*12;
      for(let k=0;k<s.len;k++){ const y=s.y+k*18, f=k/s.len; if(y<-20||y>H+20)continue; const x=s.x+lean*(1-f); const j=Math.abs((Math.sin(s.seed+k*9.7)*999+Math.floor(t*.35))|0)%this.at.n; ctx.globalAlpha=(.1+.9*(1-f))*(.22+.78*clamp(y/H,0,1)); this.at.draw(j,k===0?18:Math.max(2,Math.round(12*(1-f))),x,y); }
    }
    ctx.globalAlpha=.5; ctx.fillStyle='#8cf4ff'; ctx.fillRect(0,H-1,W,1); ctx.globalAlpha=1;
  }
};

// ================= 8. 数据织物 =================
const S_fabric = {
  id:'fabric', name:'数据织物', light:false,
  desc:'细密字符横纹像织物一样缓慢展开，明暗波纹和扫描线制造出克制、昂贵的科技质感。',
  init(){ this.fs=Math.max(12,Math.round(Math.min(W,H)/70))*spacing; this.at=makeAtlas('01  ·:;+=<>/{}[]',this.fs,ramp([[24,38,80],[50,95,170],[130,220,255],[235,245,255]],12),{weight:500,glowIf:i=>i>10}); this.rows=Math.ceil(H/(this.fs*1.45))+2; this.str=Array.from({length:this.rows},(_,r)=>({y:r*this.fs*1.45,off:rnd(500),speed:rnd(5,18),amp:rnd(4,16),ph:rnd(6.28)})); },
  frame(t){ ctx.fillStyle='#04050b';ctx.fillRect(0,0,W,H); const cw=this.fs*.63, ch=this.fs*1.45; ctx.globalCompositeOperation='lighter';
    for(const r of this.str){ const y=r.y; const wave=Math.sin(t*.28+r.ph)*r.amp; for(let c=-2;c<W/cw+2;c++){ const x=c*cw+((r.off+t*r.speed)%cw)-wave*.12; const n=(Math.sin(c*12.9898+r.off)*43758.5453)%1; const a=.05+.22*(.5+.5*Math.sin(c*.09+t*.22+r.ph)); ctx.globalAlpha=Math.max(0,a*(.35+.65*clamp(y/H,0,1))); this.at.draw(Math.abs((n*this.at.n)|0),Math.round(3+10*(.5+.5*Math.sin(c*.14+t*.25+r.ph))),x+wave*Math.sin(c*.025),y); } }
    const scan=(t*38)%(H+140)-70; const sg=ctx.createLinearGradient(0,scan-50,0,scan+50);sg.addColorStop(0,'rgba(80,210,255,0)');sg.addColorStop(.5,'rgba(90,215,255,.18)');sg.addColorStop(1,'rgba(80,210,255,0)');ctx.fillStyle=sg;ctx.fillRect(0,scan-50,W,100); ctx.globalAlpha=.14;ctx.fillStyle='#b4efff';ctx.fillRect(0,scan,W,1);
  }
};

// ================= 9. 轨道协议 =================
const S_orbit = {
  id:'orbit', name:'轨道协议', light:false,
  desc:'字符沿着几何轨道运行，中心像一枚被唤醒的协议核心；环与环之间有微弱的数据包交换。',
  init(){ const chars='0123456789ABCDEF·∴∵∆◇'; this.at=makeAtlas(chars,16,ramp([[20,36,90],[60,140,220],[150,240,255],[255,255,255]],14),{weight:600,glowIf:i=>i>12}); this.rings=[{r:.15,n:particleCount(24),sp:.8},{r:.28,n:particleCount(38),sp:-.43},{r:.43,n:particleCount(56),sp:.22},{r:.61,n:particleCount(78),sp:-.12}]; this.p=[]; },
  frame(t,dt){ ctx.fillStyle='#020309';ctx.fillRect(0,0,W,H);const cx=W*.5+(mouse.nx-.5)*18,cy=H*.5+(mouse.ny-.5)*12,R=Math.min(W,H)*.46;ctx.globalCompositeOperation='lighter';
    const halo=ctx.createRadialGradient(cx,cy,0,cx,cy,R*.8);halo.addColorStop(0,'rgba(48,130,255,.2)');halo.addColorStop(.34,'rgba(100,52,220,.06)');halo.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=halo;ctx.fillRect(0,0,W,H);
    for(const q of this.rings){const rr=R*q.r, tilt=.28+q.r*.2;ctx.globalAlpha=.12;ctx.strokeStyle='#67cfff';ctx.lineWidth=.6;ctx.beginPath();ctx.ellipse(cx,cy,rr,rr*tilt,0,0,6.28);ctx.stroke();for(let i=0;i<q.n;i++){const a=i/q.n*6.28+t*q.sp;const x=cx+Math.cos(a)*rr,y=cy+Math.sin(a)*rr*tilt;ctx.globalAlpha=.18+.72*(.5+.5*Math.sin(a*3+t));this.at.draw((i+q.n+(t*q.sp*3|0))%this.at.n,Math.round(5+9*(.5+.5*Math.sin(a+t))),x,y);}}
    for(let i=0;i<7;i++){const a=t*.35+i*.897;const rr=R*(.15+.52*((i*17)%10)/10);const x=cx+Math.cos(a)*rr,y=cy+Math.sin(a)*rr*.4;ctx.globalAlpha=.8;ctx.shadowColor='#62e7ff';ctx.shadowBlur=lowPower ? 0 : 12;ctx.fillStyle='#d7fbff';ctx.beginPath();ctx.arc(x,y,1.5,0,6.28);ctx.fill();ctx.shadowBlur=0;}
    ctx.globalAlpha=.9;ctx.strokeStyle='rgba(180,240,255,.6)';ctx.lineWidth=1;ctx.beginPath();ctx.arc(cx,cy,18+Math.sin(t)*2,0,6.28);ctx.stroke();ctx.globalAlpha=.35;ctx.beginPath();ctx.arc(cx,cy,27,0,6.28);ctx.stroke();
  }
};

// ================= 10. 流动语法 =================
const S_syntax = {
  id:'syntax', name:'流动语法', light:false,
  desc:'括号、箭头、变量和短词沿柔和的向量场流动，像代码在思考，信息却始终保持呼吸与秩序。',
  init(){this.at=makeAtlas('const let AI ask() => {} [] <> / 0 1 ·',15,ramp([[18,30,70],[40,110,190],[100,220,245],[255,255,255]],13),{weight:600,glowIf:i=>i>18});this.p=Array.from({length:particleCount(Math.min(650,Math.round(W*H/2300)))},()=>({x:rnd(W),y:rnd(H),v:rnd(16,42),ph:rnd(20),z:rnd(.4,1)}));},
  frame(t,dt){ctx.fillStyle='#03040b';ctx.fillRect(0,0,W,H);ctx.globalCompositeOperation='lighter';for(const p of this.p){const nx=(p.x/W-.5)*2,ny=(p.y/H-.5)*2;const ang=Math.sin(ny*3.4+t*.2)*.7+Math.cos(nx*2.1-t*.13)*.38; p.x+=Math.cos(ang)*p.v*dt;p.y+=Math.sin(ang)*p.v*dt;if(p.x<-20)p.x=W+20;if(p.x>W+20)p.x=-20;if(p.y<-20)p.y=H+20;if(p.y>H+20)p.y=-20;const edge=Math.min(p.x,W-p.x,p.y,H-p.y);ctx.globalAlpha=.08+.32*p.z*clamp(edge/100,0,1);this.at.draw((p.ph+(t*2|0))%this.at.n,Math.round(4+9*p.z),p.x,p.y,p.z);p.ph+=dt*(1+p.z);}
    const y=H*.52+Math.sin(t*.3)*H*.04;ctx.globalAlpha=.12;ctx.strokeStyle='#6beaff';ctx.lineWidth=1;ctx.beginPath();for(let x=0;x<W;x+=8){const yy=y+Math.sin(x*.008+t*.5)*16+Math.sin(x*.021-t*.3)*7;x?ctx.lineTo(x,yy):ctx.moveTo(x,yy);}ctx.stroke();
  }
};

// 安静的字符背景：沿用 glyph-bg.html 的 ctx / W / H / makeAtlas / ramp。
// 全局 rnd 基于 Math.random，无法指定种子；各 init 使用局部固定种子，
// 不替换全局 rnd，也不在 frame 中抽取随机数。相同尺寸下重新初始化可复现。
// t 已由外壳统一乘 0.25，此处直接使用；dt 不参与积分，避免帧率影响运动。

const S_contour = {
  id: 'contour', name: '字符等高线', light: false,
  desc: '青灰小字符沿地形等高线缓慢游移，轮廓在边缘浮现，中央留出柔和的聊天留白。',
  init() {
    let seed = 0x4c73a291;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    this.at = makeAtlas('·.:−~', 9,
      ramp([[37, 56, 61], [82, 113, 117], [135, 161, 163]], 10),
      { weight: 400, pad: 1.6 });
    this.bg = ctx.createLinearGradient(0, 0, W, H);
    this.bg.addColorStop(0, '#080f13');
    this.bg.addColorStop(1, '#0c1518');
    this.points = [];
    // 保持字小；大屏只放宽采样间距，以限制字符绘制数量。
    const gap = Math.max(11, Math.sqrt(W * H / 13000)) * spacing;
    const scale = Math.max(260, Math.min(W, H));
    for (let y = gap * .5; y < H; y += gap) {
      for (let x = gap * .5; x < W; x += gap) {
        const nx = (x - W * .5) / scale;
        const ny = (y - H * .5) / scale;
        const center = Math.exp(-Math.pow((x / W - .5) / .30, 4)
          - Math.pow((y / H - .46) / .49, 4));
        const edge = Math.min(1, x / 55, (W - x) / 55, y / 55, (H - y) / 55);
        this.points.push({
          x, y, nx, ny, c: Math.floor(random() * this.at.n),
          alpha: (.28 + random() * .15) * (1 - center * .87) * edge,
          phase: random() * Math.PI * 2,
        });
      }
    }
  },
  frame(t, dt) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, W, H);
    const a = t * .18, b = t * .12;
    for (const p of this.points) {
      // 连续标量地形的整数等值带，字符透明度沿带宽平滑衰减。
      const terrain = 2.1 * Math.sin(p.nx * 2.9 + a)
        + 1.45 * Math.cos(p.ny * 3.4 - b)
        + .73 * Math.sin((p.nx + p.ny) * 4.1 + a * .62)
        + .35 * Math.cos(p.nx * 6.1 - p.ny * 4.7 - b * .8);
      const distance = Math.sin(terrain * Math.PI);
      const line = Math.exp(-distance * distance / .035);
      const alpha = p.alpha * line;
      if (alpha < .003) continue;
      ctx.globalAlpha = alpha * 2.2;
      this.at.draw(p.c, 6, p.x + Math.sin(a + p.ny * 2) * 2.5,
        p.y + Math.cos(b + p.nx * 2) * 2, .94);
    }
    ctx.restore();
  },
};

const S_lattice = {
  id: 'lattice', name: '晶格呼吸', light: false,
  desc: '细小字符织成规则菱形晶格，边缘局部波纹轻轻起伏，亮度随呼吸变化，中央保持安静。',
  init() {
    let seed = 0x7e920c31;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    this.at = makeAtlas('·:＋◇', 8,
      ramp([[42, 54, 65], [86, 109, 122], [146, 167, 176]], 9),
      { weight: 400, pad: 1.8 });
    this.bg = ctx.createLinearGradient(0, 0, 0, H);
    this.bg.addColorStop(0, '#0a1017');
    this.bg.addColorStop(1, '#0d141c');
    this.points = [];
    const sx = Math.max(40, Math.sqrt(W * H / 950)) * spacing;
    const sy = sx * .7;
    const cols = Math.ceil(W / (2 * sx)) + 2;
    const rows = Math.ceil(H / sy) + 2;
    for (let row = -1; row <= rows; row++) {
      for (let col = -1; col <= cols; col++) {
        const x = col * sx * 2 + (row & 1) * sx;
        const y = row * sy;
        // 每个节点只绘制向下的两条边，避免重叠；节点字形保持固定。
        for (let side = -1; side <= 1; side += 2) {
          for (let k = 0; k < 5; k++) {
            if (side === 1 && k === 0) continue;
            const f = k / 5, px = x + side * sx * f, py = y + sy * f;
            if (px < -12 || px > W + 12 || py < -12 || py > H + 12) continue;
            const center = Math.exp(-Math.pow((px / W - .5) / .32, 4)
              - Math.pow((py / H - .46) / .49, 4));
            this.points.push({
              x: px, y: py,
              c: k === 0 ? (random() < .18 ? 3 : 2) : (random() < .17 ? 1 : 0),
              alpha: (.20 + random() * .09) * (1 - center * .88),
              d1: Math.hypot(px - W * .13, py - H * .66),
              d2: Math.hypot(px - W * .87, py - H * .32),
            });
          }
        }
      }
    }
    this.radius = Math.max(90, Math.min(W, H) * .33);
  },
  frame(t, dt) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, W, H);
    const breath = .84 + .16 * Math.sin(t * .42);
    for (const p of this.points) {
      const wave1 = Math.sin(p.d1 * .024 - t * .8)
        * Math.exp(-Math.pow(p.d1 / this.radius, 2));
      const wave2 = Math.sin(p.d2 * .026 - t * .65 + 2)
        * Math.exp(-Math.pow(p.d2 / this.radius, 2));
      const wave = wave1 + wave2;
      const x = p.x + wave * 1.3, y = p.y - wave * 1.8;
      const edge = Math.max(0, Math.min(1, x / 55, (W - x) / 55, y / 55, (H - y) / 55));
      ctx.globalAlpha = 2.2 * p.alpha * breath * (.9 + .12 * wave) * edge;
      this.at.draw(p.c, 6, x, y);
    }
    ctx.restore();
  },
};

const S_tide = {
  id: 'tide', name: '银色潮汐', light: false,
  desc: '稀疏银白符号分三层斜向漂浮，远层细淡、近层稍亮，像潮水缓缓穿过深灰夜色。',
  init() {
    let seed = 0x35ca81e7;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    this.bg = ctx.createLinearGradient(0, 0, W, H);
    this.bg.addColorStop(0, '#0b1016');
    this.bg.addColorStop(.6, '#10151b');
    this.bg.addColorStop(1, '#0c1117');
    this.layers = [
      { size: 7, density: 12500, speed: 9, alpha: .18 },
      { size: 9, density: 19500, speed: 16, alpha: .28 },
      { size: 11, density: 36000, speed: 25, alpha: .36 },
    ].map((layer, index) => {
      layer.at = makeAtlas('·:⋅+−/∴', layer.size,
        ramp([[71, 79, 89], [143, 152, 164], [210, 217, 225]], 10),
        { weight: 400, pad: 1.7 });
      layer.points = [];
      const count = particleCount(Math.min(220, Math.max(8, Math.round(W * H / layer.density))));
      for (let i = 0; i < count; i++) {
        layer.points.push({
          x: random() * (W + 80), y: random() * (H + 80),
          c: Math.floor(random() * layer.at.n),
          phase: random() * Math.PI * 2,
          speed: layer.speed * (.82 + random() * .36),
          alpha: layer.alpha * (.7 + random() * .3),
          level: 6 + index,
        });
      }
      return layer;
    });
  },
  frame(t, dt) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowBlur = 0;
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, W, H);
    const width = W + 80, height = H + 80;
    for (const layer of this.layers) {
      for (const p of layer.points) {
        // 解析位置直接由 t 计算；屏外循环且边缘淡出，不重新随机生成粒子。
        const x = ((p.x + t * p.speed) % width + width) % width - 40;
        const y = ((p.y - t * p.speed * .38) % height + height) % height - 40
          + Math.sin(t * .32 + p.phase) * 5;
        const edge = Math.max(0, Math.min(1, x / 70, (W - x) / 70, y / 70, (H - y) / 70));
        const center = Math.exp(-Math.pow((x / W - .5) / .30, 4)
          - Math.pow((y / H - .46) / .49, 4));
        const pulse = .88 + .12 * Math.sin(t * .44 + p.phase);
        ctx.globalAlpha = 1.7 * p.alpha * edge * (1 - center * .84) * pulse;
        layer.at.draw(p.c, p.level, x, y);
      }
    }
    ctx.restore();
  },
};

// ================= 外壳 =================
const scenes = [S_bytes, S_globe, S_sea, S_morph, S_decode, S_tokens, S_fountain, S_fabric, S_orbit, S_syntax, S_contour, S_lattice, S_tide];

const sceneMap = new Map(scenes.map(s => [s.id, s]));
let cur = null;
let motionSpeed = .25, sceneTime = 0;
let t0 = 0, last = 0, raf = 0, running = false;

function resize() {
  DPR = Math.min(lowPower ? 1 : 2, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1);
  W = cv.clientWidth || cv.width || 1; H = cv.clientHeight || cv.height || 1;
  cv.width = W * DPR | 0; cv.height = H * DPR | 0; ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  if (cur) cur.init();
}
function select(id) {
  const next = sceneMap.get(id) || scenes[0];
  cur = next;
  resize();
  sceneTime = 0; t0 = performance.now(); last = t0;
  draw(t0);
}
function draw(now) {
  if (!cur) return;
  const dt = Math.min(lowPower ? .1 : .05, Math.max(0, (now - last) / 1000)); last = now;
  if (mouse.tx < -9000) { mouse.x = mouse.y = -9999; }
  else if (mouse.x < -9000) { mouse.x = mouse.tx; mouse.y = mouse.ty; }
  else { mouse.x += (mouse.tx - mouse.x) * .2; mouse.y += (mouse.ty - mouse.y) * .2; }
  if (mouse.x > -9000) { mouse.nx += (mouse.x / W - mouse.nx) * .05; mouse.ny += (mouse.y / H - mouse.ny) * .05; }
  ctx.save(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.shadowBlur = 0;
  sceneTime += dt * motionSpeed; cur.frame(sceneTime, dt * motionSpeed); ctx.restore();
}
function loop(now) {
  if (!running) return;
  if ((typeof document === 'undefined' || !document.hidden)
      && (!lowPower || now - last >= 1000 / 15)) draw(now);
  raf = requestAnimationFrame(loop);
}
const onMove = e => { const r = cv.getBoundingClientRect(); mouse.tx = e.clientX - r.left; mouse.ty = e.clientY - r.top; };
const onLeave = () => { mouse.tx = mouse.ty = -9999; };

return {
  scenes,
  select,
  resize,
  setSpeed(v) { motionSpeed = v; },
  start() {
    if (running) return;
    running = true;
    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave);
    last = performance.now();
    raf = requestAnimationFrame(loop);
  },
  stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    window.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerleave', onLeave);
  },
  renderOnce() { if (cur) draw(performance.now()); },
  destroy() { this.stop(); cur = null; },
};
}
