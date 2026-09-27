# 实现规则：把参考代码改写成项目代码

## 1. 心法
- 参考代码是“设计的文字描述”。目标是：**看起来与设计一致**，同时**写法与仓库其余代码一致**。
- 先复用、再扩展、最后才新建：现有组件 → 给现有组件加 variant/prop → 新组件。
- 不要为了像素完美牺牲可维护性（例如到处写 `top: 37px`）；但也不要以“项目风格”为由改变设计的视觉结果。有冲突时记录并汇报。

## 2. 提示的优先级（高 → 低）
1. **Code Connect 片段**：直接用映射到的代码组件和 props。
2. **组件文档链接**：按文档用法使用组件。
3. **设计注释**：落实设计师写明的约束（最大宽度、交互、文案规则）。
4. **设计令牌 / CSS 变量**：映射到项目令牌体系。
5. **原始 hex、绝对定位、任意值**：结构最松散，只用来理解意图，以截图为准。

## 3. 令牌映射
- 用 `get_variable_defs` 的变量名在仓库里 `file_grep`：`--color-`、`colors:`、`theme.`、`tokens.json`、`Color(`、`Asset Catalog` 等。
- 匹配顺序：同名/同路径 → 同值（颜色比较归一化后的 hex，含透明度）→ 语义相近（`text/secondary` ↔ `muted-foreground`）。
- 设计值与令牌值有细微差（如 #1A73E8 vs #1A74E8）：用令牌，并在汇报中列出。
- 项目缺少的值：若多处复用或属于设计系统层面 → 建议新增令牌（按项目格式写入令牌文件）；只出现一次的局部值 → 可就地写，但加简短注释说明来源节点。
- 字体：用项目的排版令牌/文字组件；设计里的字体族若项目未加载，提醒用户而不是悄悄换成系统字体。
- 暗色模式：若变量有多个 mode（Light/Dark），确认项目主题切换机制并同时映射。

## 4. 布局改写
| Figma | Web（CSS） | 备注 |
|---|---|---|
| Auto Layout 水平/垂直 | `display:flex; flex-direction:row/column` | |
| 间距 `itemSpacing` | `gap` | 负间距用负 margin 并注释 |
| 内边距 | `padding` | |
| 主轴 / 交叉轴对齐 | `justify-content` / `align-items` | `SPACE_BETWEEN` → `space-between` |
| 尺寸 Fill container | `flex:1 1 0; min-width:0`（主轴）/ `align-self:stretch`（交叉轴） | 别忘 `min-width:0` 防止溢出 |
| 尺寸 Hug contents | 默认宽高 | |
| 尺寸 Fixed | 固定宽高，但页面级容器优先 `max-width` | |
| 换行（wrap） | `flex-wrap: wrap` + `row-gap` | |
| 绝对定位子元素（Auto Layout 中忽略布局） | `position:absolute`，父级 `relative` | 仅用于徽标、角标等叠放 |
| 约束 Left&Right / Scale | 百分比/`inset` | 非 Auto Layout 画板 |
| Grid 布局 | `display:grid` | |
- 参考代码中大量 `absolute` + 坐标：改写成 flex/grid；只保留真正叠放的元素。
- 文字：行高用设计中的值（px 或百分比 → 无单位倍数）；字距百分比换算为 `em`；`textAutoResize` 为固定高时注意截断/省略号（`text-overflow`、`line-clamp`）。
- 响应式：设计通常只给一个宽度。以画板宽度为基准，容器用 `max-width` + 自适应；设计中有多个断点画板时，分别拉取并对照。

## 5. 图片与图标（资源规则）
- **每个图标/图片都来自设计导出的资源**。禁止：手写 `<svg>/<path>`、自己新建图标文件、用图标库的“近似图标”、留下占位图或直接删掉图标。
- 资源地址 `https://…/api/mcp/asset/…` 约 7 天过期；`http://localhost:3845/assets/…` 只在本机桌面端运行时可用。要提交的代码 → 下载原字节并提交；动态内容图（头像、商品图）→ 接到数据源（props/API/CDN）。
- 下载：`curl -fsSL "<url>" -o <资源目录>/<语义名>.<ext>`；用 `file` 命令或响应头确认真实格式（SVG/PNG/JPG），不要只凭 URL 猜扩展名。
- 命名：按语义（`icon-search.svg`、`hero-illustration.png`），不要用节点 id；与仓库已有命名规范一致。
- 复用项目图标组件的前提是**字形确实一致**（打开对比），名字相同不够。
- 尺寸：图标放在宽高**同时**明确的容器里（如 24×24、`overflow:hidden`），`<img>` 设为 100% 或固定像素，绝不用 `auto`（会按原始尺寸撑开）。
- SVG 想随主题变色：可把导出的 SVG 中的 `fill`/`stroke` 改为 `currentColor`（只改颜色属性，不改路径），或按项目惯例用 SVG 组件导入。
- 位图注意 2x/3x：用 `figma-rest-export` 的 `--scale 2` 导出高清图，并设置正确的显示尺寸；照片考虑 `object-fit`。

## 6. 组件化
- 设计中重复的元素（列表项、卡片、标签）实现为一个组件 + 数据驱动渲染。
- Figma 组件的 variant 属性（`size=lg, state=hover`）映射为 props 与 CSS 状态（`:hover`、`:focus-visible`、`disabled`），不要把每个 variant 写成独立组件。
- 文案来自设计时作为 props/i18n 键，不要硬编码在深层组件里（项目若有 i18n）。

## 7. 交互与状态
- 补齐设计稿通常省略的状态：hover、focus-visible、active、disabled、loading、错误、空态、长文本溢出。设计里有对应 variant 就照做；没有则用项目现有惯例，并在汇报中注明“设计未定义”。
- 原型连线/Smart Animate 等动效交给 `figma-implement-motion` 技能。

## 8. 无障碍
- 语义化标签：按钮用 `<button>`，链接用 `<a>`，标题层级连续。
- 图片 `alt`：装饰性为空字符串；信息性写清含义。仅图标按钮要有 `aria-label`。
- 颜色对比度不足时如实报告（不擅自改色）。
- 焦点可见、键盘可达；弹窗有焦点管理。

## 9. 常见坑
- 忘记 `min-width:0` 导致 flex 子项文本溢出。
- 把设计里的固定高度照抄，导致多语言/长文本被裁。
- 行高/字重不一致：Figma 的 "Medium" 对应 500，"Semi Bold" 对应 600。
- 阴影：Figma 的 drop shadow `spread` 与 CSS 一致，但多层阴影顺序要保持；内阴影用 `inset`。
- 渐变角度：Figma 渐变用变换矩阵表示，参考代码已换算时直接用，自己换算时以截图校对。
- 描边位置：Figma 的 Inside/Outside 描边在 CSS 中需要用 `box-shadow: inset` 或 `outline` 模拟，直接 `border` 会改变盒子尺寸。
- 混合模式、背景模糊（`backdrop-filter`）兼容性要确认。
- 隐藏图层（`visible=false`）不应实现，除非它是某个状态。
