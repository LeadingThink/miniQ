# Figma 动效常见坑

运行效果与设计不一致、工具没给 `codeSnippets` 需要手写、或把片段改写到别的库时查阅。这里只收录 **Figma 特有**的问题，通用 CSS 动画常识不在此重复。

> 面向用户的提示措辞统一放在 [motion-lint-rules.md](motion-lint-rules.md)；本文件只讲技术修法。命中下列问题时，先去 lint 规则里查级别和措辞。

返回 [../SKILL.md](../SKILL.md)。

## 1. HOLD 缓动 = 阶跃，不是线性

- **现象**：某条 HOLD 轨道在页面上变成匀速渐变，而设计里是“停住再瞬间跳变”。
- **原因**：HOLD 表示保持上一关键帧的值直到分段边界再突变，CSS 等价是 `steps(1, jump-end)`（即 `step-end`）。
- **修法**：直接用工具给出的缓动，不要替换成 `linear` 或任何贝塞尔近似。motion.dev 中可用返回的阶跃写法，或用重复值 + 极小时间差表达。
- **边界**：最后一段的 HOLD 会保持最后一个关键帧的值（终态持续），这是 Figma 约定，别“纠正”成前一个值。

## 2. 时长为 0 的动画直接跳过

- **现象**：输出 `duration: 0` 的 motion 动画或 CSS `@keyframes`，挂载瞬间出现透明度闪烁或布局跳动。
- **修法**：把终态写成静态样式，不生成动画块。各库对 0 时长的处理不一致，保守为上（`motion_lint.py` 的 ML005 会提示）。

## 3. 遮罩：内容可以动，遮罩本身的属性不行

- 分组在遮罩下方做动画时，遮罩会跟随定位，这是支持的。
- 遮罩自身的尺寸、图像、位置作为关键帧目标**没有**导出路径。若用户意图就是让遮罩形状动起来，按 [unsupported-and-fallbacks.md](unsupported-and-fallbacks.md) 报告不支持并给回退。

## 4. 动画挂在 display: contents 分组上

- **现象**：动效数据里分组有正确的 `TRANSLATION_X`、`SCALE_XY`、`OPACITY` 等轨道，但页面几乎不动；生成的包裹元素类名里带 `contents`。
- **原因**：`display: contents` 去掉了元素自己的盒子，transform/opacity/transform-origin 都依赖真实盒子，结果要么无效，要么作用到子元素的方式与 Figma 的分组变换不同。
- **修法**：分组**自身在动**时，换成一个有真实盒子的包裹层（如 `position: absolute` + 明确的 left/top/width/height），把分组动效挂在它上面。
  - 新包裹层不能改变静态布局：保留节点相对同一父级的可视边界和坐标系；子元素移入后要把它们的偏移换算到新包裹层内，视觉位置不变；原点或子元素定位依赖包裹层尺寸时，显式写宽高。
  - 先确认静态画面仍与设计一致，再评判动效是否正确——边界错了的包裹层会让正确的关键帧看起来像导出 bug。
- **不要误伤**：分组**不动**时，`display: contents` 必须原样保留。把它改成定位盒子会让子元素相对一个更小的盒子重新定位而缩小/错位。
- lint：W-CONTENTS（警告），代码侧 ML003。

## 5. Motion 的 transform 会覆盖类上的定位 transform

- **现象**：用 Tailwind `left-1/2 -translate-x-1/2` 居中的元素，一加上旋转/缩放动效就偏离中心；动画结束时 computed transform 甚至变成 `none`。
- **原因**：Tailwind 的 translate 类与 Motion 的变换都写 CSS `transform`；Motion 写的是内联样式，优先级更高；当动画值回到恒等变换时可能被序列化为 `none`，把类上的平移一并抹掉。
- **修法**（二选一）：
  - 静态定位放在外层普通元素上，旋转/缩放/透明度放在内层 motion 元素上；
  - 偏移本身属于动画层时，把它写进 Motion（如 `x: "-50%"`），并在**每一个关键帧**都保留这个偏移。
- 不要在 Motion 控制 `rotate`/`scale`/`skew`/`x`/`y` 的同一元素上依赖 `translate-*` 类（ML004）。

## 6. 拆分节点与静态基准变换叠加

- `get_design_context` 可能把一个节点拆成三层：带 `data-motion-wrapper-for`/`data-motion-keys` 的外层 motion 包裹、带静态旋转与尺寸的中间层、带 `data-node-id` 的内层节点。
- `get_motion_context` 给出的变换值通常是**绝对值**（已经包含静态基准）。外层包裹只该动“相对基准的偏移”：旋转基准 30°、动画为 `[30, 150]` 时外层写 `[0, 120]`。没有静态基准的轨道（如 x/y）原样透传。
- 多轴变换、`data-motion-transform-template` 等复杂情况，按模板顺序拼接变换，必要时用 motion 的 `transformTemplate`。
- 两个常见错误：删掉中间层（元素尺寸跟随外层、丢失基准旋转）；把绝对值叠加到已有基准上（静止时旋转翻倍）。示例见 [examples-and-anti-examples.md](examples-and-anti-examples.md)。

## 7. 颜色默认在 RGB 空间插值

- **现象**：饱和红 → 饱和蓝的过渡中途变成灰浊色。
- **修法**：工具给了色彩空间提示就照用；手写时，两端颜色饱和且相距较远，优先在 OKLCH（或 HSL）空间插值，例如在关键帧里插入 OKLCH 中间色，或使用支持色彩空间的插值方式。

## 8. 旋转原点可能落在元素另一侧

- **现象**：按片段实现的环绕旋转，元素整个循环都不出现在视口内（绕着视口下方/上方转）。多见于多个“卫星”共享一个旋转中心、但起始位置不同的场景。
- **原因**：Figma 的 `transformOrigin.y` 是相对元素高度的比例（可以远大于 1，如 2.5 表示原点在元素顶部往下 250% 高度处），运行时会针对父帧解析成同级元素共享的场景坐标点；直接写成 CSS `transform-origin: x% y%` 丢掉了这层解析。
- **排查**：若元素整圈不可见，尝试把 CSS 的 Y 改为 `-(transformOrigin.y - 1) × 100%`（例如 2.5 → `-150%`），完整看一圈确认。这是排查手段，不是确定规则。

## 9. 静态资源烘焙了 t=0 的状态

- **现象**：透明度从 0 开始的元素永远看不见；给父级动画透明度到 1 也救不回来，因为 SVG 根组里写死了 `opacity="0"`，相乘仍为 0。
- **原因**：资源导出按时间轴 t=0 渲染，初始不可见（透明度 0、移出画布、缩放为 0）的状态被写进了资源本身。
- **修法**：`shell_run` 用 `curl -s <资源 URL>` 查看资源文本，检查根组上的 `opacity`/`transform`；要么内联 SVG 并删掉这些静态值，要么把透明度动画移到初始 `opacity: 1` 的外层包裹上。

## 10. 同一动画在不同时间轴组里

- `timelineCohorts` 中同组节点共享一个时间轴与循环方式。不要给同组节点各自用不同的 `repeat`/`delay` 起点，否则几个循环后会逐渐错开。整组由同一个状态/挂载时机驱动；`boomerang` 对应 `repeatType: "reverse"`（CSS 为 `animation-direction: alternate`），`loop` 对应无限重复，`once` 不重复。

## 11. 性能

- `will-change` 只给正在动画的元素加，不要全局铺（强制提升图层、占内存）。
- 弹簧不能用 `cubic-bezier` 近似：弹簧是物理模型，贝塞尔是曲线形状，手感不同。两关键帧轨道用库的弹簧类型（motion.dev `type: "spring"`）；三个及以上关键帧保留片段里烘焙好的缓动数组。

## 12. 片段存在时就信任片段

工具返回了 `codeSnippets` 就照用。以上坑只适用于：(a) 工具没给片段需要手写；(b) 运行时本身存在已知限制；(c) 把片段改写到其它库时需要保留不显眼的语义。

## 相关

- [framework-recommendations.md](framework-recommendations.md) —— 各库的缓动与原点写法
- [unsupported-and-fallbacks.md](unsupported-and-fallbacks.md) —— 没有干净导出路径的特性
- [motion-lint-rules.md](motion-lint-rules.md) —— 用户提示措辞与代码检查规则
