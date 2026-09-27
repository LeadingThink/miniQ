# SVG 与路径级动效

处理作用在 SVG 矢量上的动效，尤其是**路径级**动效（描边绘制/擦除、路径裁剪 `PATH_TRIM`）——动画挂在 `<path>` 本身，而不是外层包裹的变换上。

何时读：`get_motion_context` 为某个矢量节点返回了片段，而 `get_design_context` 中该节点是 `<img src={...}>` 资源；或片段里出现 `motion.path`、`pathLength`、`pathOffset`、`stroke-dasharray`。

返回 [../SKILL.md](../SKILL.md)。

## 一、先内联 SVG，再加路径动效

`get_design_context` 常把矢量表示为资源 URL + `<img>`，而动效作用在原始矢量的路径上。此时：

1. 去掉 `<img>`，用 `shell_run` 执行 `curl -s <资源 URL>` 取得 SVG 文本（不要下载后用 `view_image`/`file_read` 当图片读）。
2. 保留设计上下文里的外层布局包裹（定位、尺寸、`data-node-id`）。
3. 内联时保留 `viewBox`、`preserveAspectRatio`，以及路径通过 id 引用的 `<defs>`（滤镜、渐变、裁剪）。多个内联 SVG 的 `<defs>` id 可能冲突，必要时加前缀。
4. 把动效挂到与动画节点对应的那条真实 `<path>` 上。
5. 顺便检查根组有没有烘焙进 t=0 的 `opacity="0"` / `transform`（见 [gotchas.md](gotchas.md) 第 9 条）。

**整体变换**（矢量作为整体的旋转/缩放/平移/透明度）**不需要内联**，直接对现有包裹层做动画即可。只有针对路径几何的动效才需要内联。

## 二、两个独立问题决定动效挂在哪

- **包裹层的变换在动吗？**（整体 opacity / x / y / scale / rotate）→ 内联后的 `<svg>` 变成 `motion.svg`，承载这些属性。
- **路径几何在动吗？**（裁剪 / 绘制 / `stroke-dasharray`）→ 内联后的 `<path>` 变成 `motion.path`，承载这些属性。

两者可以都不、只有其一、或同时成立。同时成立时**两层都要保留**：不要把路径动效合并进包裹层，也不要丢掉任何一层。

另外注意：设计上下文里某节点是**普通 `<div>` 没有任何 motion 标记**，也可能在动——因为路径动效藏在不透明的 `<img>` 里，标记看不到。所以必须遍历 `get_motion_context` 的全部节点，不能把“普通元素”当成静态。

## 三、motion.dev 写法

把内联 `<path>` 改为 `motion.path`，保留 `d`、描边、填充和 `viewBox`，把片段的 `initial` / `animate` / `transition` 合并上去。

示例（自写，演示“两层都在动”——签名图标先下落再描边绘制）：

```tsx
import { motion, useReducedMotion } from "motion/react";

const DRAW = { duration: 1.2, ease: [0.65, 0, 0.35, 1] as const };

export function SignatureIcon() {
  const reduce = useReducedMotion();
  return (
    <div data-node-id="8:21" className="absolute left-[24px] top-[40px] size-[96px]">
      <motion.svg
        viewBox="0 0 96 96"
        fill="none"
        initial={reduce ? false : { y: -12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
      >
        <motion.path
          d="M8 70 C 24 20, 40 20, 48 60 S 72 90, 88 30"
          stroke="currentColor"
          strokeWidth={4}
          strokeLinecap="round"
          pathLength={1}
          initial={reduce ? false : { pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ ...DRAW, delay: 0.3 }}
        />
      </motion.svg>
    </div>
  );
}
```

仅路径在动时，`<svg>` 保持普通元素，只有 `<path>` 改成 `motion.path`；仅整体在动时，`<path>` 保持普通元素。数值一律照抄片段，上面数值只是示意。

## 四、CSS 路径裁剪写法

- 片段要求时，在 `<path>` 上加 `pathLength="1"`；把返回的 `animation` 样式放到该路径（类名或内联样式），返回的 `@keyframes` 只写一次。
- **为什么需要 `pathLength="1"`**：它把路径的实际长度归一化为 1，`stroke-dasharray: 0 1` 表示“一点都不画”、`1 1` 表示“全部画出”，与路径真实长度和 `viewBox` 无关。缺了它，dash 数值是用户坐标单位，不同尺寸的路径会显示错误。

自写示例：

```html
<svg viewBox="0 0 120 40" class="underline-svg" aria-hidden="true">
  <path class="underline-path" pathLength="1" d="M4 30 Q 60 4 116 30"
        fill="none" stroke="currentColor" stroke-width="3" />
</svg>
<style>
  .underline-path {
    stroke-dasharray: 0 1;
    animation: underline-draw 900ms cubic-bezier(0.33, 1, 0.68, 1) 200ms forwards;
  }
  @keyframes underline-draw {
    to { stroke-dasharray: 1 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .underline-path { animation: none; stroke-dasharray: 1 1; }
  }
</style>
```

擦除（从头部开始消失）则同时动画 `stroke-dashoffset`（或 motion.dev 的 `pathOffset`）；“行军蚁”循环用整数圈的 `stroke-dashoffset` 位移配合 `linear` + 无限重复。

## 五、片段无法往返时

起止裁剪时间不对齐、非整数回绕、`pathOffset` 越界、裁剪与颜色/描边粗细动画混用等情况可能无法干净导出。按 [unsupported-and-fallbacks.md](unsupported-and-fallbacks.md) 处理：保留 SVG、写简化的 dash 动画，或推荐 GSAP `DrawSVGPlugin` 等库；并在汇报中注明近似。

## 相关

- [examples-and-anti-examples.md](examples-and-anti-examples.md) —— 合并结构与动效的完整示例
- [framework-recommendations.md](framework-recommendations.md) —— 路径绘制/变形相关库
