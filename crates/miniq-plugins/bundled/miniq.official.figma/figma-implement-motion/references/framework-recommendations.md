# 框架与库选型建议

什么情况用哪个动效库、什么特效该交给专门的库。以下都是**建议**，用户项目已有技术栈时以其为准。

返回 [../SKILL.md](../SKILL.md)。

## 一、默认框架

| 目标平台 | 默认 | 说明 |
|---|---|---|
| React | motion.dev（`motion` 包，`import { motion } from "motion/react"`） | 工具直接产出 motion.dev 代码；支持关键帧、弹簧、滚动联动、手势、布局动画 |
| 原生 / 非 React Web | CSS `@keyframes` + `animation` 简写 | 工具直接产出 CSS，无运行时开销 |
| SwiftUI | `.animation(...)`、`withAnimation`、`matchedGeometryEffect`、`KeyframeAnimator` | 工具**不**产出 SwiftUI 代码，需从 CSS 片段或 `keyframeBindings` 翻译（见下） |
| Android Compose | `animate*AsState`、`Animatable`、`updateTransition`、`keyframes {}` | 工具暂不产出 Compose 代码，需自行翻译 |

项目里已经用了 Framer Motion、React Spring、GSAP、anime.js 或 Vue `<Transition>` 等，就**改写到那个库**，不要额外引入 motion.dev。决定前先 `file_grep` 目标文件及相邻组件的 import。

### 改写到其它库时的对应关系（常用）

| 概念 | motion.dev | CSS | GSAP |
|---|---|---|---|
| 时长 | `duration`（秒） | `animation-duration`（s/ms） | `duration`（秒） |
| 贝塞尔缓动 | `ease: [x1, y1, x2, y2]` | `cubic-bezier(x1, y1, x2, y2)` | `CustomEase` 或近似的具名缓动（需说明） |
| 多段关键帧时间点 | `times: [0, 0.3, 1]` | `@keyframes` 百分比 `0% / 30% / 100%` | timeline 中按比例拆分 |
| 循环 | `repeat: Infinity` | `animation-iteration-count: infinite` | `repeat: -1` |
| 往返 | `repeatType: "reverse"` | `animation-direction: alternate` | `yoyo: true` |
| 阶跃（HOLD） | 阶跃缓动或重复值 | `step-end` / `steps(1, jump-end)` | `ease: "steps(1)"` |
| 变换原点 | `style={{ transformOrigin }}` 或 `originX/originY` | `transform-origin` | `transformOrigin` |

## 二、SwiftUI 翻译

两条原则：

1. **只写真实存在的 SwiftUI API。** 没有能直接接收 Figma/CSS 缓动名的修饰符，不要臆造便捷方法；不确定时查 Apple 文档。
   - 时间曲线：`.linear(duration:)`、`.easeIn` / `.easeOut` / `.easeInOut(duration:)`、`.timingCurve(_:_:_:_:duration:)`
   - 弹簧：`.spring(duration:bounce:)`、`.interpolatingSpring(mass:stiffness:damping:initialVelocity:)`
   - 多段关键帧（iOS 17 / macOS 14 起）：`KeyframeAnimator`、`KeyframeTrack`，内含 `LinearKeyframe`、`CubicKeyframe`、`SpringKeyframe`、`MoveKeyframe`
2. **按实际输出的缓动做映射**，不要凭名字猜：

| 输出的缓动 | SwiftUI | 备注 |
|---|---|---|
| `linear` | `.linear(duration: d)` | 精确 |
| `cubic-bezier(a, b, c, d)`（Figma BEZIER） | `.timingCurve(a, b, c, d, duration: t)` | 四个控制点照抄；超出 [0,1] 的回弹曲线也能传，但要目测效果 |
| 弹簧（Figma SPRING / CUSTOM_SPRING） | `.spring(duration: t, bounce: b)` | 优先使用输出里的 `bounce`；手头只有质量/刚度/阻尼时可用 `.interpolatingSpring(...)` |
| `step-end`（Figma HOLD） | 无时间曲线：保持旧值、在分段边界瞬间切换（无动画地赋值，或在 `KeyframeAnimator` 中重复值后用 `MoveKeyframe`） | 与 CSS `step-end` 语义一致 |

自写示例（非对标代码）：

```swift
struct PulseDot: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var on = false

    var body: some View {
        Circle()
            .frame(width: 12, height: 12)
            .scaleEffect(on ? 1.3 : 1.0, anchor: .bottomTrailing) // 原点对应 transformOrigin 100% 100%
            .animation(reduceMotion ? nil :
                .timingCurve(0.2, 0.8, 0.3, 1, duration: 0.6).repeatForever(autoreverses: true),
                value: on)
            .onAppear { on = true }
    }
}
```

Compose 对应思路：`rememberInfiniteTransition()` + `animateFloat(..., infiniteRepeatable(tween(600, easing = CubicBezierEasing(0.2f, 0.8f, 0.3f, 1f)), RepeatMode.Reverse))`；读取系统“移除动画”设置（`Settings.Global.ANIMATOR_DURATION_SCALE` 为 0）时直接给终态。

翻译完成后**完整验证一个动画**再批量——弹簧手感最容易在不同参数化之间走样。

## 三、按特效类别选库

下列特效有浏览器兼容、无障碍和性能上的坑，优先用成熟库而不是手写关键帧：

| 特效 | 推荐 | 说明 |
|---|---|---|
| 玻璃 / 毛玻璃 | 先用 CSS `backdrop-filter`；只有折射/液态玻璃才考虑 WebGL 或专门库 | 简单玻璃就是模糊 + 半透明 + 描边几个属性；Safari 部分版本支持有限，用 `@supports` 特性检测 |
| 彩纸 / 粒子爆发 | `canvas-confetti`、`react-confetti`、`party-js` | 用关键帧硬凑要几十行且兼容性差，库一行搞定 |
| 持续粒子系统 | `tsParticles`；3D 用 `three.js` / `@react-three/fiber` | 雪花、火星等背景，关键帧做不出体积和纵深 |
| 滚动联动 | `motion/react` 的 `useScroll` + `useTransform`；复杂序列用 GSAP `ScrollTrigger` | 这些库已处理好 IntersectionObserver / rAF 与尺寸变化 |
| 文字逐字/打字机 | `splitting.js`、motion.dev 逐字 `variants` + `staggerChildren`、anime.js 文字相关能力 | 手写逐字拆分容易在连字、RTL、动态内容上出错；注意保留可读的完整文本给读屏 |
| SVG 路径变形 | GSAP `MorphSVGPlugin`、`flubber` | 任意路径间插值涉及点数不一致，交给库 |
| SVG 描边绘制 | motion.dev `motion.path` + `pathLength`；GSAP `DrawSVGPlugin`；简单情况用 CSS `stroke-dasharray`/`stroke-dashoffset` | 见 [svg-and-path-motion.md](svg-and-path-motion.md) |
| 拖拽 / 手势 | motion.dev 的 `drag`、`@use-gesture/react` | 统一处理触摸/指针差异 |
| 弹簧物理 | 用项目现有库的 spring 原语（motion.dev、react-spring、framer-motion 都有） | **永远不要用 cubic-bezier 近似** |

## 四、反模式

- 浏览器原生支持时，不要用嵌套滤镜或 canvas 重造 `backdrop-filter`；不支持时做特性检测和降级，不要拿 DOM 技巧打补丁。
- 不要堆几十个 `@keyframes` 假装粒子效果，改用 canvas 或粒子库。
- 除非用户明确要求，不要用贝塞尔近似弹簧。
- 不要给所有元素加 `will-change: transform`；只给正在动的元素加，并在结束后移除。

## 相关

- [gotchas.md](gotchas.md) —— Figma 特有的动效坑
- [unsupported-and-fallbacks.md](unsupported-and-fallbacks.md) —— 没有干净导出路径的特性
