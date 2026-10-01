# 不支持的特性与回退方案

目前没有干净代码导出路径的 Figma 动效特性。设计依赖这些特性时，要么选择回退方案，要么向用户说明限制，**不要**交付渲染不出来的代码。

本文状态是某一时间点的判断：以工具实际返回为准。若 `get_motion_context` 对下列某项返回了片段，就说明已支持，直接信任工具输出。

> 面向用户的固定措辞见 [motion-lint-rules.md](motion-lint-rules.md)；本文只讲回退方案。

返回 [../SKILL.md](../SKILL.md)。

## 一、无法代码生成的特性

| 特性 | 现状 | 回退方案 | lint |
|---|---|---|---|
| **弧线参数**（弧起点 / 扫角 / 内径比） | CSS 与 motion.dev 都没有对应属性，无法导出 | 预渲染为视频；简单圆弧可用 SVG 弧线路径 + 手写平移/旋转关键帧近似（需标注“近似”） | — |
| **GenEffect（生成式着色效果）代码导出** | 代码里只有运动，没有着色器视觉 | 追求还原 → 视频导出；只想复用运动节奏或自己重做效果 → 代码导出可用 | — |
| **GenEffect 的视频导出** | 服务端视频导出不运行 GenEffect，运动正常但效果缺失 | 让用户在 Figma 本地导出视频，把效果烘焙进去 | — |
| **GIF / 动画 SVG** | MCP 不能导出，矢量图层只有各自的静态 SVG | 动态位图 → 视频；动态矢量 → 把静态 SVG 引入 Motion.dev / Lottie 等运行时，再按动效上下文的关键帧重新施加 | L-ANIMATED-EXPORT（错误） |
| **路径裁剪的非常规时序** | 常见情形已支持：描边绘制/擦除、起止对齐的“擦除”、整数圈的行军蚁；CSS 对应 `stroke-dasharray`+`stroke-dashoffset`，motion.dev 对应 `motion.path` 的 `pathLength`/`pathOffset` 或 `strokeDashoffset` | 起止轨道关键帧时间不对齐、非整数回绕、`pathOffset` 越界、与颜色/描边粗细等动画混用时可能不能往返：保留 SVG，写简化的 dash 动画，或推荐库（见 [framework-recommendations.md](framework-recommendations.md)） | — |
| **组件变体过渡 / 原型交互 / Smart Animate** | 与关键帧动画走不同数据通路，MCP 暂未提供 | 用条件渲染 / 状态类实现两个变体，在变化的属性上加短 `transition` 求“足够接近”；有 REST 数据或用户规格时按 [prototype-and-rest-fallback.md](prototype-and-rest-fallback.md) 精确还原时长与缓动 | L-PROTO（错误） |
| **动画遮罩**（遮罩自身的图像/尺寸/位置作为关键帧目标） | 遮罩下的分组动画定位正确；遮罩本身不能动 | 保持遮罩静止、只动遮罩内容；设计确需遮罩形状变化 → 视频，或借助库做 SVG `clip-path` 动画 | — |
| **复杂矢量网络与布尔运算** | 静态导出就可能不完美，动起来会放大瑕疵 | 导出为拍平的 SVG，整体做 transform/opacity 动画；逐帧精度重要时 → 视频 | — |

## 二、代码不够用时的非代码格式

- **Lottie**：适合复杂矢量动画（After Effects + Bodymovin 导出），用 Lottie 播放器渲染，设计保持为数据。
- **视频（MP4 / WebM）**：代码确实复现不了的动效（3D、大量粒子、需与音频精确同步）。失去交互，但画面永远准确。记得提供 `poster` 与减少动效时的静态替代。
- **动画 WebP / APNG**：颜色有限的短循环，带宽低于视频。
- **SMIL（SVG 内置动画）**：浏览器支持参差，一般优先 CSS/JS；知道它存在，便于阅读旧代码。

## 三、拿不准就问用户

特性含义模糊或工具只返回了部分数据时，**把不确定性说出来**，不要默默近似。用 `ask_user` 给出选项，例如：

> 设计中的“进度环扫角”动画使用了弧线参数，无法按原样生成代码。请选择：
> A. 用 SVG 描边绘制做一个近似效果（会标注为近似）
> B. 引入专门的库实现
> C. 使用视频 / Lottie 回退

这比交付一个坏掉的实现要好得多。汇报时列出每个回退点：节点、原因、采用的方案。

## 相关

- [gotchas.md](gotchas.md) —— 已支持但有已知问题的特性
- [framework-recommendations.md](framework-recommendations.md) —— 可以填补空缺的库
- [motion-lint-rules.md](motion-lint-rules.md) —— 固定措辞
