# 缓动曲线参考

> 属于 `figma-use-motion` 技能。在给关键帧设置 `easing`，或给动画样式的 `props.easing` 赋值时阅读。

## 1. 缓动对象结构

缓动是一个带 `type` 的对象，与原型交互 Smart Animate 过渡用的是同一结构，另外多了动效专用的 `HOLD`：

```js
{ type: "EASE_IN_AND_OUT" }
```

**语义**：某个关键帧上的缓动，描述的是"从**上一个**关键帧运动到**本**关键帧"这一段的节奏。因此第一个关键帧的缓动不会生效（它前面没有关键帧）。

## 2. 全部可用枚举

| `type` | 类别 | 感受 | 附加字段 |
|---|---|---|---|
| `LINEAR` | 基础 | 匀速，机械感 | 无 |
| `EASE_IN` | 三次曲线 | 慢起快收，像加速离开 | 无 |
| `EASE_OUT` | 三次曲线 | 快起慢收，像减速到位 | 无 |
| `EASE_IN_AND_OUT` | 三次曲线 | 两头慢中间快 | 无 |
| `EASE_IN_BACK` | 回弹 | 起步前先反向蓄力 | 无 |
| `EASE_OUT_BACK` | 回弹 | 冲过终点再回落 | 无 |
| `EASE_IN_AND_OUT_BACK` | 回弹 | 两端都有轻微越界 | 无 |
| `CUSTOM_CUBIC_BEZIER` | 自定义 | 任意贝塞尔曲线 | `easingFunctionCubicBezier` 必填 |
| `GENTLE` | 弹簧预设 | 柔和 | 无 |
| `QUICK` | 弹簧预设 | 利落 | 无 |
| `BOUNCY` | 弹簧预设 | 明显弹跳 | 无 |
| `SLOW` | 弹簧预设 | 舒缓 | 无 |
| `CUSTOM_SPRING` | 自定义 | 指定弹性强度 | `easingFunctionSpring` 必填 |
| `HOLD` | 阶跃（仅动效） | 保持旧值，到点瞬间跳变 | **不得**带任何附加字段 |

### 常见写错

| 错误写法 | 正确写法 | 原因 |
|---|---|---|
| `EASE_IN_OUT` | `EASE_IN_AND_OUT` | 公开 schema 不接受缩写 |
| `EASE_IN_OUT_BACK` | `EASE_IN_AND_OUT_BACK` | 同上 |
| `OUT_CUBIC`、`INOUT_CUBIC`、`CUSTOM_CUBIC` | `EASE_OUT`、`EASE_IN_AND_OUT`、`CUSTOM_CUBIC_BEZIER` | 内部场景图名称，会被拒绝 |
| `SPRING_PRESET_ONE` 等 | `GENTLE` / `QUICK` / `BOUNCY` / `SLOW` | 同上 |
| `{ easingType: ... }` | `{ type: ... }` | 样式 `props` 文档字符串里的写法只是提示，不能照抄 |
| `"ease-out"` 字符串 | `{ type: "EASE_OUT" }` | 必须是对象 |

## 3. 自定义贝塞尔 `CUSTOM_CUBIC_BEZIER`

参数与 CSS `cubic-bezier(x1, y1, x2, y2)` 一致：`x1`、`x2` 应在 0–1 之间，`y1`、`y2` 可以超出 0–1（产生越界回弹）。

```js
{
  type: "CUSTOM_CUBIC_BEZIER",
  easingFunctionCubicBezier: { x1: 0.2, y1: 0, x2: 0, y2: 1 }
}
```

常用曲线参考值（便于与前端实现对齐）：

| 用途 | x1, y1, x2, y2 |
|---|---|
| 标准减速入场（类 Material "emphasized decelerate"） | 0.05, 0.7, 0.1, 1 |
| 通用平滑 | 0.4, 0, 0.2, 1 |
| 强减速（"expo out" 近似） | 0.16, 1, 0.3, 1 |
| 离场加速 | 0.4, 0, 1, 1 |
| 轻微越界 | 0.34, 1.4, 0.64, 1 |
| CSS `ease-out` 等效 | 0, 0, 0.58, 1 |

示例：把某节点的纵向位移用自定义曲线写入（单轨道写法）：

```js
const target = await figma.getNodeByIdAsync("12:34");
if (!target) throw new Error("找不到节点 12:34");

const decel = {
  type: "CUSTOM_CUBIC_BEZIER",
  easingFunctionCubicBezier: { x1: 0.16, y1: 1, x2: 0.3, y2: 1 },
};

target.applyManualKeyframeTrack(
  { type: "PROPERTY", name: "TRANSLATION_Y" },
  {
    keyframes: [
      { timelinePosition: 0, value: { type: "FLOAT", value: 48 } },
      { timelinePosition: 0.6, value: { type: "FLOAT", value: 0 }, easing: decel },
    ],
  },
);

return { mutatedNodeIds: [target.id], tracks: target.manualKeyframeTracks };
```

## 4. 自定义弹簧 `CUSTOM_SPRING`

只有一个参数 `bounce`，取值 **0–1**（超出范围会抛错）：

- `0`：平稳收敛，没有越界；
- 0.1–0.25：细微弹性，适合 UI；
- 0.3–0.5：明显弹跳，适合趣味、提示；
- 越接近 1 振荡越多。

```js
{ type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: 0.2 } }
```

如果用户（或前端代码）给的是物理弹簧参数（质量、刚度、阻尼），先换算：

```js
const b = figma.motion.physicalSpringToNormalized({ mass: 1, stiffness: 170, damping: 26 });
const springEasing = { type: "CUSTOM_SPRING", easingFunctionSpring: { bounce: b } };
```

回读关键帧时，`easingFunctionSpring` 中只会有 `bounce`，不会保留原始物理参数；需要时在交付说明里注明原始值。

## 5. 阶跃 `HOLD`

保持上一关键帧的值，直到到达本关键帧的时间点时瞬间切换。**只写 `type`**：

```js
{ type: "HOLD" }
```

适用：离散状态切换（开/关、显示/隐藏）、逐格揭示、打字机式逐字出现、刻意的生硬跳变、闪烁光标。

## 6. 在动画样式里设置缓动

部分动画样式暴露了 `easing` 属性。先读样式定义确认属性名：

```js
const all = figma.motion.figmaAnimationStyles();
const def = all.find((s) => s.name === "Fade");
return def ? { styleId: def.styleId, props: def.props } : { error: "未找到 Fade 样式" };
```

`props` 返回的是**说明文字**（例如带有 `default: { easingType: OUT_CUBIC }` 字样），只能用来确认有哪些属性，不能照抄写回。写入时一律用公开的缓动对象：

```js
const el = await figma.getNodeByIdAsync("12:34");
const def = figma.motion.figmaAnimationStyles().find((s) => s.name === "Fade");
if (!def) throw new Error("未找到 Fade 样式");

const instanceId = el.applyAnimationStyle(def.styleId, {
  duration: 0.45,
  timelineOffset: 0.1,
  props: { timing: "in", easing: { type: "QUICK" } },
});

return { mutatedNodeIds: [el.id], instanceId, styles: el.animationStyles };
```

## 7. 按场景选择缓动

| 场景 | 推荐缓动 | 参考时长 |
|---|---|---|
| 元素入场（出现、滑入、放大显示） | `EASE_OUT` / 强减速贝塞尔 / `GENTLE` | 0.3–0.6s |
| 元素离场（消失、滑出） | `EASE_IN` | 0.2–0.35s（比入场短） |
| 屏幕内位置/尺寸变化、展开折叠 | `EASE_IN_AND_OUT` / `QUICK` | 0.3–0.5s |
| 按钮按下、开关、小反馈 | `QUICK` / `EASE_OUT` | 0.12–0.25s |
| 需要"有弹性"的强调（徽标、点赞） | `EASE_OUT_BACK` / `CUSTOM_SPRING` bounce 0.2–0.4 | 0.35–0.6s |
| 趣味、儿童、游戏化 | `BOUNCY` | 0.5–0.8s |
| 大面积、背景、氛围 | `SLOW` / `EASE_IN_AND_OUT` | 0.8–2s |
| 进度条、旋转加载、跑马灯（匀速循环） | `LINEAR` | 按周期 |
| 颜色渐变 | `LINEAR` 或 `EASE_IN_AND_OUT` | 0.3–1s |
| 离散切换、逐帧、光标闪烁 | `HOLD` | — |

选择原则：

1. **入场减速、离场加速**：进入视野的东西应"刹车到位"，离开的东西应"加速走掉"。
2. **UI 默认克制**：没有明确要求时优先 `EASE_OUT`、`EASE_IN_AND_OUT`、`GENTLE`、`QUICK`；回弹与强弹簧只用于需要强调的少数元素。
3. **同一组元素用同一缓动**，差异靠时间偏移体现，否则会显得杂乱。
4. **位移越大时长越长**，但 UI 中很少超过 0.7s。
5. **与前端对齐**：若动效最终要落地为代码，优先使用贝塞尔曲线，并在交付说明中给出等效的 CSS `cubic-bezier()`，便于 `figma-implement-motion` 或开发者直接复用。
