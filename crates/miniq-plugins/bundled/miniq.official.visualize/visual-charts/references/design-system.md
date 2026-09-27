# 设计系统速查（assets/viz-base.css）

`viz.py wrap` 会自动内联这份样式。自由构图时优先使用这里的令牌和工具类，不要自己写一套颜色和字号。

## 颜色令牌（浅色、深色自动切换）
| 令牌 | 用途 |
|---|---|
| `--background` / `--foreground` | 页面底色 / 正文 |
| `--card` / `--card-foreground` | 卡片表面 / 卡片内文字 |
| `--muted` / `--muted-foreground` | 次要表面 / 次要文字（单位、说明、时间） |
| `--border` / `--grid` | 分隔线 / 图表网格线（细且中性） |
| `--primary` / `--primary-foreground` | 唯一的高强调操作 |
| `--destructive` / `--success` / `--warning` | 错误 / 成功 / 警示文本 |
| `--viz-series-1` … `--viz-series-6` | 数据系列颜色，**只用于**图形、标记和图例色块 |
| `--viz-positive` / `--viz-negative` | 涨跌 |

规则：
- 所有颜色都取自令牌，包括 SVG 的 `fill`/`stroke`，写成 `var(--viz-series-1)`。Canvas 或 ECharts 用 `getComputedStyle(root).getPropertyValue(...)` 读取令牌值。
- 单一度量或当前选中项用 `--viz-series-1`，对比项用 `--viz-series-2`。同一类别在所有视图中保持同一种颜色。
- 不要给进度条、网格加装饰性描边。网格线用 1px 的 `--grid`。

## 排版
- 基础字号为 14px，次要文字用 `.text-small`（12px）。不要自定义其他字号。
- 字重只用 400 和 500。
- 页面里只放一个简洁的可见标题（h1–h3 选一个）。
- 变化的数字、需要对齐的数字加 `.tabular-nums`。

## 布局与组件
| 类 | 用途 |
|---|---|
| `.viz-root` | 页面根容器，最大宽度 1080px（由 wrap 自动添加） |
| `.card` | 唯一的卡片表面 |
| `.viz-grid` | 自适应的指标网格或选项网格 |
| `.viz-row` | 可换行的横向分组 |
| `.viz-controls` | 同一组控件所在的行 |
| `.viz-stat` + `.label`/`.value`/`.delta.up|down` | KPI 卡片 |
| `.viz-badge` | 只用于展示的状态小标签 |
| `.viz-chart` | 图表容器，最小高度 320px（窄屏 260px） |
| `.viz-tooltip` | 绝对定位的提示框，显示时把 opacity 设为 1 |
| `.viz-source` | 数据来源脚注 |
| `.btn` / `.btn-primary` | 次要按钮 / 主要按钮；切换状态用 `aria-pressed` |
| `.form-label` `.form-control` `.form-select` `.form-range` `.form-check` | 原生表单控件 |
| `.table` `.table-responsive` `.text-end` | 数据表 |
| `.sr-only` | 只给读屏软件看的文字 |

## 片段写法示例
```html
<div id="loan-calc">
  <h2>房贷月供随利率变化</h2>
  <div class="viz-controls">
    <label><span class="form-label">年利率 <output id="rate-out">3.5%</output></span>
      <input class="form-range" id="rate" type="range" min="2" max="6" step="0.05" value="3.5"></label>
  </div>
  <div class="viz-grid">
    <div class="card viz-stat"><div class="label">月供</div><div class="value" id="pay" aria-live="polite">—</div></div>
  </div>
  <svg id="curve" class="viz-chart" role="img" aria-label="月供随利率变化曲线"></svg>
</div>
<script>
  const root = document.getElementById("loan-calc");
  // ……按 id 取元素，只在本地计算，不发请求
</script>
```
