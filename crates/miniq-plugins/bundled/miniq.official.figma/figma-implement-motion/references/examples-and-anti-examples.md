# 正例与反例

每个示例都按“`get_design_context` 给结构 + `get_motion_context` 给动画（用 `data-node-id` 关联）→ 最终代码”展示。示例代码均为自写的示意，节点 id 与数值是虚构的；实际工作中数值一律照抄工具返回。

返回 [../SKILL.md](../SKILL.md)。

## 正例 1：单个元素，动效整体挂上去

```tsx
// get_design_context（结构）
<div data-node-id="3:10">
  <motion.div data-node-id="3:11"><img src={imgLoader} alt="" /></motion.div>
</div>

// get_motion_context 中 3:11 的片段（动画）
// initial={{ rotate: 0 }} animate={{ rotate: [0, 360] }}
// transition={{ duration: 1.6, ease: "linear", repeat: Infinity }}
```

```tsx
// 结果：结构不变，只把 initial/animate/transition 合并到对应元素
<div data-node-id="3:10">
  <motion.div
    data-node-id="3:11"
    initial={{ rotate: 0 }}
    animate={reduce ? undefined : { rotate: [0, 360] }}
    transition={{ duration: 1.6, ease: "linear", repeat: Infinity }}
  >
    <img src={imgLoader} alt="" />
  </motion.div>
</div>
```

## 正例 2：没有 motion 标记的文字节点也在动

设计上下文里是普通 `<p>`，但动效上下文为它返回了动画。以 `get_motion_context` 为准：找到同 `data-node-id` 的元素，改成 `motion.p`，**文字、span、类名、属性一律不动**。

```tsx
// get_design_context
<p data-node-id="5:40" className="text-[14px] text-emerald-600">
  <span>{`▲ 12 `}</span><span>本月新增</span>
</p>

// get_motion_context 5:40：透明度 + 上移淡入，延迟 0.2s
```

```tsx
<motion.p
  data-node-id="5:40"
  className="text-[14px] text-emerald-600"
  initial={{ opacity: 0, y: 8 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.45, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
>
  <span>{`▲ 12 `}</span><span>本月新增</span>
</motion.p>
```

若 `motion.p` 在目标框架中不方便（如语义或 SSR 限制），可在外面包一层不影响布局的 `motion.div`，但 `data-node-id` 仍要与动画节点关联，文本不改写。

## 正例 3：拆分节点 + 静态基准旋转（交错变换）

设计上下文把节点拆成三层：外层 motion 包裹（带 `data-motion-wrapper-for`、`data-motion-keys`）、中间的静态旋转与尺寸层、内层节点。动效上下文给出的旋转是**绝对值**（从 30° 基准起）。

```tsx
// get_design_context
<motion.div data-motion-wrapper-for="7:2" data-motion-keys="rotate,x">
  <div className="rotate-30 w-[58px] h-[58px]">
    <div data-node-id="7:2"><img src={imgArrow} alt="" /></div>
  </div>
</motion.div>

// get_motion_context 7:2：rotate: [30, 210, 210], x: [0, 64, 64]
```

```tsx
// 结果：三层全保留；外层只动“相对基准的偏移”
<motion.div
  data-motion-wrapper-for="7:2"
  initial={{ rotate: 0, x: 0 }}
  animate={{ rotate: [0, 180, 180], x: [0, 64, 64] }}   // 210 - 30 = 180；x 无基准原样透传
  transition={{ duration: 1.2, times: [0, 0.6, 1], ease: "easeInOut", repeat: Infinity }}
>
  <div className="rotate-30 w-[58px] h-[58px]">
    <div data-node-id="7:2"><img src={imgArrow} alt="" /></div>
  </div>
</motion.div>
```

两个典型错误：删掉中间层（矢量尺寸跟随外层变大、丢了基准旋转）；把绝对值 `[30, …]` 直接放在外层（静止时累计旋转 60°）。若外层带 `data-motion-transform-template`，用 `transformTemplate={(_, generated) => "<模板中的静态变换> " + generated}` 让动画变换叠在静态布局变换之上。

## 正例 4：多个节点共享同一动画 —— 抽象而不是复制

五个柱状条动画相同，只差交错延迟：

```tsx
const BAR_GROW = {
  initial: { scaleY: 0 },
  animate: { scaleY: 1 },
} as const;
const BAR_EASE = [0.34, 1.2, 0.64, 1] as const; // 照抄片段中的回弹曲线
const BARS = [
  { id: "9:1", h: 40 }, { id: "9:2", h: 72 }, { id: "9:3", h: 56 },
  { id: "9:4", h: 88 }, { id: "9:5", h: 64 },
];

export function Bars() {
  return (
    <div className="flex items-end gap-2">
      {BARS.map((b, i) => (
        <motion.div
          key={b.id}
          data-node-id={b.id}
          {...BAR_GROW}
          style={{ height: b.h, transformOrigin: "50% 100%" }}   // 从底部长出
          transition={{ duration: 0.5, ease: BAR_EASE, delay: i * 0.06 }}
        />
      ))}
    </div>
  );
}
```

反例：把同一个 `transition` 对象手抄五遍（`motion_lint.py` 的 ML006 会提示）。

## 正例 5：SVG 路径绘制

设计上下文里是 `<div data-node-id=…><img/></div>`（没有任何 motion 标记），动效上下文却返回 `motion.path` 的描边绘制。做法：内联 SVG，`<svg>` 保持普通元素，只把对应 `<path>` 改为 `motion.path` 并加 `pathLength={1}`。完整写法（包括只有包裹层动、两层都动的情况）见 [svg-and-path-motion.md](svg-and-path-motion.md)。

## 反例 1：重建 DOM

```tsx
// ❌ 把层级拍平：外层包裹 3:11 消失、data-node-id 丢失、动画直接挂在 img 上
<div>
  <motion.img src="/loader.svg" animate={{ rotate: [0, 360] }} transition={{ repeat: Infinity }} />
</div>
```

为什么错：`get_design_context` 已经给出正确的 DOM，应保持其层级与 `data-node-id`，把动效**叠加**在这棵树上。若片段返回的是 `motion.svg`，唯一需要的改动是把矢量内联成 `<svg>` 并对它做动画，外层包裹必须保留。

## 反例 2：镜像兄弟节点位置互换

一个旋转的分组里有左右两份镜像矢量，动效上下文让分组和**右边**那份（`4:21`）额外旋转。

```tsx
// ✅ 设计上下文：每个 id 绑定自己的 inset（第 4 个值是 left）
<motion.div data-node-id="4:20">
  <motion.div className="absolute inset-[10%_5%_10%_55%]" data-node-id="4:21">…</motion.div>
  <div className="absolute inset-[10%_55%_10%_5%]" data-node-id="4:22">…</div>
</motion.div>

// ❌ 抄写时把两者位置对调了
<motion.div style={{ left: "5%", right: "55%" }} data-node-id="4:21">…</motion.div>
<div style={{ left: "55%", right: "5%" }} data-node-id="4:22">…</div>
```

动效仍挂在正确的 id 上，但它的位置漂到了兄弟节点那边，于是**错误的那一份**在额外旋转。左右/上下镜像对最容易出这种错。做法：位置、尺寸、结构、属性、文字全部取自 `get_design_context`，并与动效所指的同一 `data-node-id` 绑定；只有动画数值来自 `get_motion_context`。

## 反例 3：`transformOrigin` 只写了外层

```tsx
// 动效上下文：外层 6:1 与内层 6:2 都从右下角缩放，各自带 transformOrigin: "100% 100%"
<motion.div data-node-id="6:1" style={{ transformOrigin: "100% 100%" }} animate={{ scale: [0, 1] }}>
  {/* ❌ 内层没写原点 → 默认 50% 50%，从中心长出 */}
  <motion.div data-node-id="6:2" animate={{ scale: [0, 0, 1] }}>…</motion.div>
</motion.div>
```

修正：每个缩放/旋转节点都写上它**自己的** `transformOrigin`。关键帧数值正确但原点缺失时，动画会从错误的角落开始。

## 反例 4：捏造动效

```tsx
// ❌ 动效上下文只给了卡片标题动画，却“顺手”给卡片正文、按钮也加了同款淡入
```

没有动效数据的节点保持静止；不要借用设计里别处的时长/缓动“补齐”。如果你认为缺动效，写进汇报并 `ask_user`，而不是自行添加。

## 反例 5：用贝塞尔近似弹簧、用线性替代 HOLD

```tsx
// ❌ Figma 规格为 SPRING（bounce 0.3），却写成 ease: [0.34, 1.56, 0.64, 1]
// ✅ transition={{ type: "spring", bounce: 0.3, duration: 0.6 }}（数值以片段为准）
// ❌ HOLD 轨道写成 ease: "linear"
// ✅ 保留片段中的阶跃缓动（CSS 为 step-end）
```

## 相关

- [svg-and-path-motion.md](svg-and-path-motion.md)
- [gotchas.md](gotchas.md)
