# 网页演示稿骨架

单文件 HTML，无外链依赖（ECharts 可选）。1920×1080 画布，JS 等比缩放；`?print-pdf` 切换打印布局。令牌 CSS 来自 `../../visual-language-core/references/tokens.md`，此处只写骨架与两套主题差异。

## 1. 公共骨架

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>演示稿标题</title>
<style>
/* ① 粘贴 tokens.md 的 :root / dark 令牌 */

/* ② 画布与缩放 */
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font-family: var(--font); overflow: hidden; }
#deck { position: relative; width: 100vw; height: 100vh; }
.slide {
  position: absolute; left: 50%; top: 50%; width: 1920px; height: 1080px;
  transform: translate(-50%, -50%) scale(var(--scale, 1));
  transform-origin: center; padding: 96px 120px; display: none; flex-direction: column;
  background: var(--bg);
}
.slide.active { display: flex; }
.slide .no { position: absolute; right: 64px; bottom: 48px; color: var(--muted); font-size: 20px; font-variant-numeric: tabular-nums; }
.notes { display: none; }

/* ③ 通用元素（字号基于 1920 宽） */
.slide h1 { margin: 0 0 24px; font-weight: 600; line-height: 1.2; }
.slide h2 { margin: 0 0 32px; font-weight: 600; line-height: 1.25; }
.slide p, .slide li { font-size: 32px; line-height: 1.7; margin: 0 0 .5em; }
.slide ul { padding-left: 1.2em; margin: 0; }
.slide .big { font-size: 160px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; color: var(--primary); }
.slide .muted { color: var(--muted); font-size: 24px; }
.slide .chart { flex: 1; min-height: 0; }
.slide .source { color: var(--muted); font-size: 20px; margin-top: 16px; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 64px; flex: 1; min-height: 0; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 40px; }

/* ④ 打印布局：?print-pdf */
@page { size: 1920px 1080px; margin: 0; }
body.print { overflow: visible; }
body.print #deck { width: auto; height: auto; }
body.print .slide { position: relative; left: auto; top: auto; transform: none; display: flex; break-after: page; }
body.print.notes .notes { display: block; position: absolute; left: 120px; bottom: 48px; right: 240px; font-size: 20px; color: var(--muted); }
</style>
</head>
<body>
<main id="deck">

  <section class="slide cover">
    <h1>演示稿主标题</h1>
    <p class="muted">副标题 · 讲者 · 2026-10-10</p>
    <aside class="notes">开场备注。</aside>
  </section>

  <section class="slide">
    <h2>每页一个观点，标题就是观点句</h2>
    <ul><li>要点一（≤ 24 字）</li><li>要点二</li><li>要点三</li></ul>
  </section>

  <section class="slide">
    <h2>华东贡献了 62% 的增长</h2>
    <p class="muted">按发货日期统计，2026-01 至 2026-09</p>
    <div class="chart" id="c1"></div>
    <p class="source">来源：销售系统导出 · 截至 2026-09-30</p>
  </section>

  <section class="slide end">
    <h1>谢谢</h1>
    <p class="muted">联系方式 / 二维码</p>
  </section>

</main>

<script>
(() => {
  const slides = [...document.querySelectorAll('.slide')];
  const params = new URLSearchParams(location.search);
  const isPrint = params.has('print-pdf');
  if (isPrint) {
    document.body.classList.add('print');
    if (params.has('notes')) document.body.classList.add('notes');
  }
  slides.forEach((s, i) => {
    const n = document.createElement('div'); n.className = 'no'; n.textContent = `${i + 1} / ${slides.length}`; s.appendChild(n);
  });
  let cur = Math.min(Math.max(parseInt(location.hash.slice(1)) || 1, 1), slides.length) - 1;
  const show = (i) => {
    cur = Math.min(Math.max(i, 0), slides.length - 1);
    slides.forEach((s, k) => s.classList.toggle('active', k === cur));
    history.replaceState(null, '', `#${cur + 1}`);
    window.dispatchEvent(new Event('slidechange'));
  };
  const fit = () => {
    const sc = Math.min(innerWidth / 1920, innerHeight / 1080);
    document.documentElement.style.setProperty('--scale', sc);
  };
  if (!isPrint) {
    fit(); addEventListener('resize', fit); show(cur);
    addEventListener('keydown', (e) => {
      if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); show(cur + 1); }
      else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); show(cur - 1); }
      else if (e.key === 'Home') show(0);
      else if (e.key === 'End') show(slides.length - 1);
      else if (e.key.toLowerCase() === 'f') document.documentElement.requestFullscreen?.();
    });
    addEventListener('click', (e) => { if (!e.target.closest('a,button')) show(cur + 1); });
    addEventListener('hashchange', () => show((parseInt(location.hash.slice(1)) || 1) - 1));
  } else {
    slides.forEach(s => s.classList.add('active'));
  }
})();
</script>

<!-- 可选：ECharts。无图表时整段删除 -->
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js"></script>
<script>
(() => {
  if (!window.echarts) return;
  const css = getComputedStyle(document.documentElement), v = n => css.getPropertyValue(n).trim();
  echarts.registerTheme('miniq', {
    color: [v('--s1'), v('--s2'), v('--s3'), v('--s4'), v('--s5'), v('--s6')],
    textStyle: { fontFamily: v('--font'), color: v('--fg'), fontSize: 22 },
    legend: { textStyle: { color: v('--muted'), fontSize: 22 } },
    grid: { left: 64, right: 32, top: 48, bottom: 48, containLabel: true },
    categoryAxis: { axisLine: { lineStyle: { color: v('--line') } }, axisTick: { show: false }, axisLabel: { color: v('--muted'), fontSize: 22 } },
    valueAxis: { splitLine: { lineStyle: { color: v('--grid') } }, axisLabel: { color: v('--muted'), fontSize: 22 } },
    tooltip: { backgroundColor: v('--card'), borderColor: v('--line'), textStyle: { color: v('--fg') } }
  });
  const charts = [];
  const make = (id, option) => {
    const el = document.getElementById(id); if (!el) return;
    const c = echarts.init(el, 'miniq'); c.setOption(option); charts.push(c);
  };
  make('c1', {
    xAxis: { type: 'category', data: ['华东', '华北', '华南', '西南', '其他'] },
    yAxis: { type: 'value', name: '万元', min: 0 },
    series: [{ type: 'bar', data: [1260, 480, 410, 220, 130], barMaxWidth: 96, itemStyle: { borderRadius: [8, 8, 0, 0] } }]
  });
  const resizeAll = () => charts.forEach(c => c.resize());
  addEventListener('slidechange', () => setTimeout(resizeAll, 0));
  addEventListener('resize', resizeAll);
  setTimeout(resizeAll, 0);
})();
</script>
</body>
</html>
```

要点：
- 图表容器在 `display: none` 的页里初始化会得到 0 尺寸，所以监听 `slidechange` 后 `resize()`；打印模式所有页同时可见，无此问题。
- `--print-to-pdf` 前要等 ECharts 渲染完成，Chromium headless 默认等待页面加载完成，一般足够；PDF 中图表页空白时加 `--virtual-time-budget=3000` 参数让渲染多等 3 秒，或把 ECharts 内联到文件中消除网络等待。

## 2. 杂志风 `theme-mag`

在 `<body class="theme-mag">` 上加类；主色朱砂 / 绛紫 / 杏黄任一。

```css
.theme-mag .slide { padding: 120px 144px; }
.theme-mag .slide h1 { font-size: 96px; letter-spacing: -.01em; max-width: 1200px; }
.theme-mag .slide h2 { font-size: 72px; max-width: 1300px; }
.theme-mag .slide p, .theme-mag .slide li { font-size: 34px; max-width: 1100px; }
.theme-mag .cover, .theme-mag .end, .theme-mag .accent { background: var(--primary); color: var(--primary-fg); }
.theme-mag .accent h2, .theme-mag .cover .muted, .theme-mag .end .muted { color: var(--primary-fg); opacity: .85; }
.theme-mag .cover h1 { margin-top: auto; }       /* 标题压底 */
.theme-mag .big { font-size: 220px; }
.theme-mag .slide .no { font-size: 22px; }
.theme-mag .kicker { color: var(--primary); font-size: 24px; font-weight: 600; letter-spacing: .08em; margin-bottom: 24px; }
.theme-mag .accent .kicker { color: var(--primary-fg); }
```

节奏建议：每 4–5 页插入一页 `.accent` 主色整页（章节标题或一句金句），其余页大留白、左对齐、单栏。图片页用 `.cols` 一半图一半字，图片 `object-fit: cover; border-radius: 16px`。

## 3. 极简商务风 `theme-biz`

`<body class="theme-biz">`；主色黛蓝（默认）/ 青灰。

```css
.theme-biz .slide { padding: 88px 120px 96px; }
.theme-biz .slide::before { content: attr(data-section); position: absolute; left: 120px; top: 40px; color: var(--muted); font-size: 20px; }
.theme-biz .slide::after { content: ""; position: absolute; left: 120px; right: 120px; top: 76px; height: 1px; background: var(--line); }
.theme-biz .slide h1 { font-size: 64px; }
.theme-biz .slide h2 { font-size: 48px; padding-left: 20px; border-left: 6px solid var(--primary); }
.theme-biz .slide p, .theme-biz .slide li { font-size: 30px; }
.theme-biz .cover::before, .theme-biz .cover::after, .theme-biz .end::before, .theme-biz .end::after { display: none; }
.theme-biz .cover { justify-content: center; }
.theme-biz .cover h1 { border-bottom: 4px solid var(--primary); display: inline-block; padding-bottom: 24px; align-self: flex-start; }
.theme-biz .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px; }
.theme-biz .kpi .label { color: var(--muted); font-size: 24px; }
.theme-biz .kpi .value { font-size: 88px; font-weight: 600; line-height: 1.1; font-variant-numeric: tabular-nums; }
.theme-biz .kpi .delta.up { color: var(--up); } .theme-biz .kpi .delta.down { color: var(--down); }
.theme-biz table { width: 100%; border-collapse: collapse; font-size: 26px; font-variant-numeric: tabular-nums; }
.theme-biz th { text-align: left; color: var(--muted); font-weight: 500; font-size: 22px; padding: 14px 16px; border-bottom: 2px solid var(--line); }
.theme-biz td { padding: 14px 16px; border-bottom: 1px solid var(--line); }
.theme-biz .slide .footer { position: absolute; left: 120px; bottom: 48px; color: var(--muted); font-size: 20px; }
```

每页 `<section class="slide" data-section="二、市场分析">` 写章节名；页脚 `.footer` 放公司名或"内部资料"。图表页：标题结论句 + `.muted` 口径 + `.chart` + `.source`。

## 4. 页型速查

| 页型 | 结构 | 两套主题差异 |
|---|---|---|
| 封面 | h1 + 副标题（讲者 · 日期） | 杂志风主色整页；商务风白底 + 主色下划线 |
| 章节页 | 一句话 | 杂志风 `.accent`；商务风 h1 + 章节序号 |
| 要点页 | h2 + ≤ 3 条 | 字号差异 |
| 大数字页 | `.big` + 一句解释 | 杂志风 220px；商务风 3 个 `.kpi` 并排 |
| 图表页 | h2 结论 + `.muted` 口径 + `.chart` + `.source` | 相同 |
| 对比页 | `.cols` 两卡片 或 表格 | 商务风优先表格 |
| 结束页 | 谢谢 + 联系方式 / 二维码 | 同封面 |

## 5. 截图与导出命令备忘

```bash
# 本地服务
python3 -m http.server 0 --directory "<落点>"
# 导出 PDF（替换端口）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="<落点>/deck.pdf" "http://127.0.0.1:<端口>/deck.html?print-pdf"
# 单页 PNG（第 3 页）
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1920,1080 --screenshot="<落点>/slide-03.png" "http://127.0.0.1:<端口>/deck.html#3"
```
