# 设计令牌（可直接内联到 HTML）

```css
:root {
  --bg: #FAFAF8;
  --fg: #1F2328;
  --muted: #6B7280;
  --card: #FFFFFF;
  --line: #E5E7EB;
  --grid: #EEF0F2;
  --primary: #2B4C7E;           /* 黛蓝；按场景换成其他主色 */
  --primary-fg: #FFFFFF;
  --up: #2E8B57;
  --down: #C8323B;
  --s1: #2B4C7E; --s2: #E8A33D; --s3: #2E8B57;
  --s4: #C8323B; --s5: #6B3E8C; --s6: #6C7A89;
  --radius: 12px;
  --font: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "Helvetica Neue", Arial, sans-serif;
  --mono: "SF Mono", Menlo, Consolas, "Noto Sans Mono CJK SC", monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141516; --fg: #E6E6E3; --muted: #9CA3AF;
    --card: #1D1F21; --line: #2A2D31; --grid: #232629;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 400 16px/1.75 var(--font);
  -webkit-font-smoothing: antialiased;
}
.page { max-width: 1080px; margin: 0 auto; padding: 48px; }
@media (max-width: 640px) { .page { padding: 24px; } }
h1 { font-size: 32px; font-weight: 600; line-height: 1.3; margin: 0 0 8px; }
h2 { font-size: 22px; font-weight: 600; line-height: 1.4; margin: 40px 0 16px; }
h3 { font-size: 17px; font-weight: 600; line-height: 1.5; margin: 24px 0 8px; }
p { margin: 0 0 1em; }
.muted { color: var(--muted); font-size: 13px; line-height: 1.6; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 24px; }
.grid { display: grid; gap: 24px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.kpi .label { color: var(--muted); font-size: 13px; }
.kpi .value { font-size: 40px; font-weight: 600; line-height: 1.1; font-variant-numeric: tabular-nums; }
.kpi .delta { font-size: 13px; }
.kpi .delta.up { color: var(--up); } .kpi .delta.up::before { content: "▲ "; }
.kpi .delta.down { color: var(--down); } .kpi .delta.down::before { content: "▼ "; }
.chart { min-height: 320px; }
.source { color: var(--muted); font-size: 12px; margin-top: 12px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; }
th { color: var(--muted); font-weight: 500; font-size: 13px; }
td.num, th.num { text-align: right; }
.btn { display: inline-block; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); cursor: pointer; }
.btn-primary { background: var(--primary); color: var(--primary-fg); border-color: var(--primary); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
```

## ECharts 主题片段

```js
const css = getComputedStyle(document.documentElement);
const v = n => css.getPropertyValue(n).trim();
const theme = {
  color: [v('--s1'), v('--s2'), v('--s3'), v('--s4'), v('--s5'), v('--s6')],
  textStyle: { fontFamily: v('--font'), color: v('--fg') },
  title: { textStyle: { fontSize: 17, fontWeight: 600, color: v('--fg') }, subtextStyle: { color: v('--muted') } },
  legend: { textStyle: { color: v('--muted') } },
  grid: { left: 48, right: 24, top: 56, bottom: 40, containLabel: true },
  categoryAxis: { axisLine: { lineStyle: { color: v('--line') } }, axisTick: { show: false }, axisLabel: { color: v('--muted') } },
  valueAxis: { splitLine: { lineStyle: { color: v('--grid') } }, axisLabel: { color: v('--muted') } },
  tooltip: { backgroundColor: v('--card'), borderColor: v('--line'), textStyle: { color: v('--fg') } }
};
echarts.registerTheme('miniq', theme);
const chart = echarts.init(el, 'miniq');
```

## Python matplotlib 片段

```python
import matplotlib
from matplotlib import font_manager as fm, pyplot as plt
for name in ["PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei"]:
    if any(f.name == name for f in fm.fontManager.ttflist):
        plt.rcParams["font.family"] = name
        break
plt.rcParams["axes.unicode_minus"] = False
SERIES = ["#2B4C7E", "#E8A33D", "#2E8B57", "#C8323B", "#6B3E8C", "#6C7A89"]
plt.rcParams["axes.prop_cycle"] = matplotlib.cycler(color=SERIES)
plt.rcParams.update({"axes.spines.top": False, "axes.spines.right": False,
                     "axes.edgecolor": "#E5E7EB", "grid.color": "#EEF0F2", "axes.grid": True, "axes.axisbelow": True})
```

## 字体检查命令

- macOS：系统自带 PingFang SC，无需检查。
- Linux：`fc-list :lang=zh | head`；为空时 `sudo apt install fonts-noto-cjk` 或提示用户安装。
- Windows：系统自带 Microsoft YaHei。
- 导出 PDF（Chromium）时字体来自系统；导出 PDF（reportlab/weasyprint）时需要显式注册字体文件。
