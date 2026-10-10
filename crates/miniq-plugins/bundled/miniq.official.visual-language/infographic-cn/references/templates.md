# 信息图模板骨架

五个模板共用同一外壳。所有尺寸以 1080 宽为基准，其他宽度按比例换算字号。CSS 变量来自 `../../visual-language-core/references/tokens.md`，此处只列模板增量。

## 公共外壳

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>标题</title>
<style>
/* 1. 此处粘贴 tokens.md 的 :root / dark / body 基线 */
/* 2. 信息图外壳 */
html, body { width: 1080px; }           /* 高度按需：1350 / 1440 / 1920 */
body { min-height: 1350px; padding: 64px; display: flex; flex-direction: column; }
.hd h1 { font-size: 52px; line-height: 1.25; margin: 0 0 12px; }
.hd .sub { color: var(--muted); font-size: 22px; line-height: 1.5; }
.hd .bar { width: 72px; height: 6px; background: var(--primary); border-radius: 3px; margin: 24px 0 40px; }
.bd { flex: 1; }
.ft { margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: 18px; display: flex; justify-content: space-between; }
</style>
</head>
<body>
  <header class="hd"><h1>结论句标题</h1><div class="sub">口径 · 时间范围</div><div class="bar"></div></header>
  <main class="bd"><!-- 模板主体 --></main>
  <footer class="ft"><span>来源：……</span><span>截至 2026-10-10</span></footer>
</body>
</html>
```

## 1. 数字卡片（2×2 / 2×3）

```html
<style>
.kpis { display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; }
.kpi { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 32px; }
.kpi .label { color: var(--muted); font-size: 22px; }
.kpi .value { font-size: 68px; font-weight: 600; line-height: 1.1; font-variant-numeric: tabular-nums; color: var(--primary); margin: 8px 0; }
.kpi .value small { font-size: 26px; font-weight: 400; color: var(--fg); margin-left: 6px; }
.kpi .note { font-size: 20px; line-height: 1.5; }
.kpi .delta.up { color: var(--up); } .kpi .delta.down { color: var(--down); }
</style>
<section class="kpis">
  <div class="kpi"><div class="label">年度营收</div><div class="value">12.6<small>亿元</small></div><div class="note delta up">▲ 同比 +18.2%</div></div>
  <!-- 重复 3–5 个 -->
</section>
```

规则：最多 6 个；最重要的一个可跨两列（`grid-column: span 2`）并放大到 96px。

## 2. 步骤流程（纵向编号）

```html
<style>
.steps { display: flex; flex-direction: column; gap: 20px; }
.step { display: grid; grid-template-columns: 72px 1fr; gap: 24px; align-items: start; }
.step .no { width: 72px; height: 72px; border-radius: 50%; background: var(--primary); color: var(--primary-fg); font-size: 32px; font-weight: 600; display: grid; place-items: center; }
.step h3 { font-size: 28px; margin: 8px 0 6px; }
.step p { font-size: 22px; line-height: 1.6; color: var(--fg); margin: 0; }
.step + .step .no { position: relative; }
.step + .step .no::before { content: ""; position: absolute; left: 50%; top: -20px; width: 2px; height: 20px; background: var(--line); }
</style>
<section class="steps">
  <div class="step"><div class="no">1</div><div><h3>提交申请</h3><p>线上填写表单，附营业执照扫描件。</p></div></div>
  <!-- 3–7 步 -->
</section>
```

横版（1200×628）改为 `grid-template-columns: repeat(N, 1fr)`，步骤间用内联 SVG 箭头 `<svg viewBox="0 0 24 24"><path d="M5 12h14m-6-6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2"/></svg>`。

## 3. 对比表

```html
<style>
.cmp { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 22px; }
.cmp th { font-size: 24px; font-weight: 600; padding: 20px; background: var(--card); border-bottom: 2px solid var(--primary); }
.cmp th:first-child { text-align: left; color: var(--muted); font-weight: 500; border-bottom-color: var(--line); }
.cmp td { padding: 18px 20px; border-bottom: 1px solid var(--line); text-align: center; }
.cmp td:first-child { text-align: left; color: var(--muted); }
.cmp .yes { color: var(--up); } .cmp .no { color: var(--down); }
.cmp .hl { background: color-mix(in srgb, var(--primary) 6%, transparent); }
</style>
<table class="cmp">
  <thead><tr><th>维度</th><th class="hl">方案 A</th><th>方案 B</th></tr></thead>
  <tbody>
    <tr><td>部署周期</td><td class="hl">2 周</td><td>6 周</td></tr>
    <tr><td>私有化</td><td class="hl yes">✓ 支持</td><td class="no">✗ 不支持</td></tr>
  </tbody>
</table>
```

规则：最多 3 列对象、6 行维度；推荐项用 `.hl` 淡主色底，不用红绿填充整列；✓ ✗ 必须配文字。

## 4. 时间线（左轴右卡片）

```html
<style>
.tl { position: relative; padding-left: 48px; }
.tl::before { content: ""; position: absolute; left: 11px; top: 8px; bottom: 8px; width: 2px; background: var(--line); }
.ev { position: relative; margin-bottom: 28px; }
.ev::before { content: ""; position: absolute; left: -44px; top: 10px; width: 16px; height: 16px; border-radius: 50%; background: var(--primary); border: 4px solid var(--bg); }
.ev time { display: block; color: var(--primary); font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ev h3 { font-size: 26px; margin: 4px 0 6px; }
.ev p { font-size: 21px; color: var(--muted); margin: 0; line-height: 1.6; }
</style>
<section class="tl">
  <div class="ev"><time>2024-03</time><h3>立项</h3><p>完成需求调研与可行性评估。</p></div>
  <!-- 4–7 个 -->
</section>
```

时间格式统一：`YYYY-MM` 或 `YYYY 年 M 月`，一张图只用一种。

## 5. 金字塔 / 漏斗（SVG 内联）

```html
<style>
.fn { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; align-items: center; }
.fn svg { width: 100%; height: auto; }
.fn ol { list-style: none; margin: 0; padding: 0; font-size: 22px; }
.fn li { padding: 14px 0; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; }
.fn li b { font-variant-numeric: tabular-nums; color: var(--primary); }
</style>
<section class="fn">
  <svg viewBox="0 0 400 360" role="img" aria-label="转化漏斗">
    <!-- 四层漏斗：宽度按比例，颜色用 --primary 的不同透明度 -->
    <polygon points="0,0 400,0 340,90 60,90"    fill="var(--primary)" opacity=".95"/>
    <polygon points="60,90 340,90 290,180 110,180" fill="var(--primary)" opacity=".75"/>
    <polygon points="110,180 290,180 250,270 150,270" fill="var(--primary)" opacity=".55"/>
    <polygon points="150,270 250,270 225,360 175,360" fill="var(--primary)" opacity=".35"/>
    <text x="200" y="52" text-anchor="middle" fill="#fff" font-size="26" font-weight="600">访问 10 万</text>
    <text x="200" y="142" text-anchor="middle" fill="#fff" font-size="24">注册 2.4 万</text>
    <text x="200" y="232" text-anchor="middle" fill="#fff" font-size="22">下单 6,800</text>
    <text x="200" y="322" text-anchor="middle" fill="var(--fg)" font-size="20">复购 1,200</text>
  </svg>
  <ol>
    <li>访问 → 注册 <b>24%</b></li>
    <li>注册 → 下单 <b>28%</b></li>
    <li>下单 → 复购 <b>18%</b></li>
  </ol>
</section>
```

金字塔把 `polygon` 上下颠倒即可（底宽顶窄）。层数 3–5；每层内文字要保证对比度，最窄层文字放到图形外侧。

## 尺寸换算

| 宽度 | 外边距 | 标题 | 大数字 | 正文 | 来源 |
|---|---|---|---|---|---|
| 1080 | 64px | 52px | 68px | 22–24px | 18px |
| 1200（横版 628 高） | 56px | 40px | 72px（只放 1–3 个） | 22px | 16px |
| 1600（幻灯片插图） | 72px | 44px | 64px | 24px | 18px |
