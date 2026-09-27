# 图表样式指南

## 版式
- 标题（结论句，左对齐）→ 副标题（指标口径、时间范围）→ 图 → 脚注（来源、截至日期、说明）
- 尺寸：报告内 8×4.5 英寸、dpi 150–200；幻灯片 16:9
- 去掉多余元素：上/右边框、密集网格线（保留浅灰水平线）、不必要的图例

## 配色（建议）
- 主色 `#2563EB`，强调 `#F97316`，正向 `#16A34A`，负向 `#DC2626`，中性 `#9CA3AF`
- 分类色（最多 8 个）：`#2563EB #F97316 #10B981 #8B5CF6 #EF4444 #14B8A6 #EAB308 #64748B`
- 顺序色阶：浅 `#EFF6FF` → 深 `#1E3A8A`；发散色阶：`#DC2626` ↔ `#F3F4F6` ↔ `#2563EB`
- 同一实体全篇同色

## 数字格式
- 千分位：`12,345`；大数：`1.2 万`、`3.4 亿`（中文受众）或 `1.2K / 3.4M`
- 百分比保留 0–1 位小数；变化量写正负号：`+3.2%`、`−1.1pp`
- 直接在柱/线尾标注关键数值，减少读者对轴

## matplotlib 中文字体
```python
import matplotlib
from matplotlib import font_manager
cands = ["PingFang SC", "Hiragino Sans GB", "Heiti SC", "STHeiti", "Songti SC",
         "Microsoft YaHei", "SimHei", "Noto Sans CJK SC", "Source Han Sans SC",
         "WenQuanYi Zen Hei", "Arial Unicode MS"]
have = {f.name for f in font_manager.fontManager.ttflist}
for name in cands:
    if name in have:
        matplotlib.rcParams["font.sans-serif"] = [name] + matplotlib.rcParams["font.sans-serif"]
        break
matplotlib.rcParams["axes.unicode_minus"] = False
```
- 无头环境使用 `matplotlib.use("Agg")`
- 保存：`fig.savefig(path, dpi=180, bbox_inches="tight")`

## 可访问性
- 对比度足够；不只用颜色区分（加标签、线型或标记）
- 图片提供替代文字（在报告中写一句话描述）

## 交互 HTML 图表要点（无 CDN）
- 用内联 `<svg>` 绘制，`<title>` 元素提供悬浮提示，或用少量原生 JS 显示 tooltip
- 数据以 `<script type="application/json">` 内嵌
- 页面宽度自适应：`viewBox` + `width:100%`
