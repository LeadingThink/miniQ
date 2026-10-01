# 动效模式与 API 用法

> 属于 `figma-use-motion` 技能。任何通过 `use_figma` 读写动效之前阅读。所有代码都在 `use_figma` 中执行：顶层 `await`、用 `return` 返回、不调用 `figma.closePlugin()` 与 `figma.notify()`，并返回每个被修改的节点 ID。遇到 `"not a supported API"` 立即停止（账号未开通动效）。

## 目录

1. 标准流程
2. 盘点动效状态
3. 手动关键帧：数据结构与字段白名单
4. 手动关键帧：增、改、删
5. 颜色轨道（fills / strokes）
6. 效果轨道（effects）
7. 动画样式
8. 时间轴时长
9. 变换坐标说明
10. 常用动效配方
11. 动效设计默认值
12. 常见坑速查

---

## 1. 标准流程

1. **先读后写**：确认选区或目标节点、父节点类型、已有 `manualKeyframeTracks`、已有 `animationStyles`、`timelines`。
2. **选实现方式**：用户点名就照做；新动效默认用手动关键帧；与现成样式吻合、要绑定设计系统动效 token、或与相邻节点保持一致时用动画样式。
3. **不动静态设计**：除非用户要求，不新建、删除、解组或重排节点。
4. **最小改动**：只写需要的轨道/样式，保留其他已有数据。
5. **按需延长时间轴**：动画结束时间超过当前时长才延长，不主动缩短。
6. **回读校验**：返回更新后的轨道/样式数据与 `mutatedNodeIds`。

动画永远加在顶层 frame 的**子孙节点**上，不加在顶层 frame（页面直接子节点）本身。

## 2. 盘点动效状态

```js
// 盘点：选区优先，没有选区就用传入的 ID 列表
const ids = ["12:34"]; // 按需替换
const picked = figma.currentPage.selection.length
  ? [...figma.currentPage.selection]
  : (await Promise.all(ids.map((i) => figma.getNodeByIdAsync(i)))).filter(Boolean);

return picked.map((n) => ({
  id: n.id,
  name: n.name,
  type: n.type,
  parentType: n.parent ? n.parent.type : null,
  isTopLevelFrame: n.parent ? n.parent.type === "PAGE" : false,
  timelines: n.timelines,
  tracks: n.manualKeyframeTracks,
  styles: n.animationStyles,
}));
```

若 `isTopLevelFrame` 为 `true`，不要在它上面加动画，改为处理它的子节点。

## 3. 手动关键帧：数据结构与字段白名单

`node.manualKeyframeTracks` 是一个对象：键为可动画字段名，值为轨道 `{ id?, baseValue?, keyframes: [...] }`。单个关键帧：

```js
{
  timelinePosition: 0.4,                 // 秒
  value: { type: "FLOAT", value: 1 },     // 或 VECTOR / COLOR
  easing: { type: "EASE_OUT" }            // 从上一帧到本帧的节奏，见 motion-easing.md
}
```

值类型：`{ type: "FLOAT", value: n }`、`{ type: "VECTOR", value: { x, y } }`、`{ type: "COLOR", value: { r, g, b, a } }`（颜色分量 0–1）。

新建轨道时**不要写 `baseValue`**，由 API 从节点推导；编辑已有轨道时保留原 `id`、`baseValue` 与各关键帧 `id`。

### 3.1 变换字段——与静止态叠加

| 字段 | 值 | 叠加方式 | 说明 |
|---|---|---|---|
| `TRANSLATION_X` | FLOAT 像素 | 相加，中性值 0 | 正值向右 |
| `TRANSLATION_Y` | FLOAT 像素 | 相加，中性值 0 | 正值向下 |
| `TRANSLATION_XY` | VECTOR 像素 | 相加，中性值 `{x:0,y:0}` | X/Y 需同一轨道同一节奏时用 |
| `ROTATION` | FLOAT 角度 | 相加，中性值 0 | 正值**逆时针**（与 `node.rotation` 一致）；不归一化，`-360` 表示顺时针整转一圈 |
| `SCALE_X` / `SCALE_Y` | FLOAT 倍率 | 相乘，中性值 1 | 0.5 为当前尺寸一半 |
| `SCALE_XY` | FLOAT 或 VECTOR 倍率 | 相乘，中性值 1 / `{x:1,y:1}` | 等比缩放 |

写 `TRANSLATION_Y: 40` 的意思是"在静止位置基础上再往下 40px"，不是"移到 y=40"。

### 3.2 绝对字段——在动画期间取代原值

| 字段 | 值 | 说明 |
|---|---|---|
| `OPACITY` | FLOAT 0–1 | 与 `node.opacity` 同义 |
| `CORNER_RADIUS` | FLOAT 像素 | 统一圆角 |
| `RECTANGLE_TOP_LEFT_CORNER_RADIUS` 等四个角 | FLOAT 像素 | 分角圆角（TOP_LEFT/TOP_RIGHT/BOTTOM_LEFT/BOTTOM_RIGHT） |
| `STROKE_WEIGHT`、`BORDER_TOP_WEIGHT`、`BORDER_BOTTOM_WEIGHT`、`BORDER_LEFT_WEIGHT`、`BORDER_RIGHT_WEIGHT` | FLOAT 像素 | 描边粗细 |
| `STACK_SPACING`、`STACK_COUNTER_SPACING`、`STACK_PADDING_LEFT/TOP/RIGHT/BOTTOM`、`GRID_ROW_GAP`、`GRID_COLUMN_GAP` | FLOAT 像素 | 自动布局/网格间距与内边距 |
| `PATH_TRIM_START`、`PATH_TRIM_END` | FLOAT 0–1 | 路径裁剪，可做"描线"动画 |
| `WIDTH`、`HEIGHT` | FLOAT 像素 | 必须为正；group 与 vector 不支持 |

### 3.3 会直接抛错的字段

`SHEAR`、`SCROLL_OFFSET_X/Y`、`DISSOLVE_PROGRESS`、`MEDIA_CURRENT_TIME`、各类 3D 变换、多边形/弧形参数、`VARIANT_PROPERTIES`、任何 `MOTION_*` 内部名。即使在类型定义里看到，也不要使用。

### 3.4 首帧之前、末帧之后

- 第一个关键帧的值**向前保持到 t=0**：若轨道第一帧在 2s，0–2s 期间一直是第一帧的值，无需额外补一个 t=0 帧。
- 最后一个关键帧的值**向后保持到时间轴结束**。
- 因此第一帧上的 `easing` 没有作用。

这正好用于"延迟入场"：第一帧放在延迟时间点，值为隐藏态。

## 4. 手动关键帧：增、改、删

### 4.1 新增单条轨道（推荐 `applyManualKeyframeTrack`）

它只影响一条轨道，不必展开重建整个对象。字段描述符：普通属性用 `{ type: "PROPERTY", name: "OPACITY" }`；效果用 `{ type: "INDEXED_ITEM", collection: "effects", index, field }`。颜色轨道建议用整体赋值（见 §5）。

```js
// 让节点在 0.5s 内从左侧 80px 处滑回原位
const el = await figma.getNodeByIdAsync("12:34");
if (!el) throw new Error("节点不存在");
const endAt = 0.5;
const changed = [el.id];

el.applyManualKeyframeTrack(
  { type: "PROPERTY", name: "TRANSLATION_X" },
  {
    keyframes: [
      { timelinePosition: 0, value: { type: "FLOAT", value: -80 } },
      { timelinePosition: endAt, value: { type: "FLOAT", value: 0 }, easing: { type: "EASE_OUT" } },
    ],
  },
);

const tl = el.timelines[0];
if (tl && tl.duration < endAt) {
  el.setTimelineDuration(tl.id, endAt);
  changed.push(tl.id);
}
return { mutatedNodeIds: changed, tracks: el.manualKeyframeTracks, timelines: el.timelines };
```

### 4.2 一次写多条轨道（整体赋值）

需要同时写多条轨道时，可对整个对象赋值，**务必先展开旧值**：

```js
const el = await figma.getNodeByIdAsync("12:34");
const prev = el.manualKeyframeTracks || {};
const f = (v) => ({ type: "FLOAT", value: v });

el.manualKeyframeTracks = {
  ...prev,
  OPACITY: { keyframes: [
    { timelinePosition: 0, value: f(0) },
    { timelinePosition: 0.4, value: f(1), easing: { type: "EASE_OUT" } },
  ] },
  SCALE_XY: { keyframes: [
    { timelinePosition: 0, value: f(0.92) },
    { timelinePosition: 0.4, value: f(1), easing: { type: "GENTLE" } },
  ] },
};
return { mutatedNodeIds: [el.id], tracks: el.manualKeyframeTracks };
```

### 4.3 修改已有轨道

保留轨道与关键帧的 `id`，只改需要改的字段：

```js
// 把 OPACITY 轨道最后一帧的时间挪到 0.6s，并改用 EASE_IN_AND_OUT
const el = await figma.getNodeByIdAsync("12:34");
const prev = el.manualKeyframeTracks || {};
const op = prev.OPACITY;
if (!op) throw new Error("该节点没有 OPACITY 轨道");

const last = op.keyframes.length - 1;
el.manualKeyframeTracks = {
  ...prev,
  OPACITY: {
    ...op,
    keyframes: op.keyframes.map((k, i) =>
      i === last ? { ...k, timelinePosition: 0.6, easing: { type: "EASE_IN_AND_OUT" } } : k),
  },
};
return { mutatedNodeIds: [el.id], opacity: el.manualKeyframeTracks.OPACITY };
```

### 4.4 删除轨道

```js
const el = await figma.getNodeByIdAsync("12:34");

// 方式一：用辅助方法删除单条
el.removeManualKeyframeTrack({ type: "PROPERTY", name: "ROTATION" });

// 方式二：解构剔除后写回（适合一次删多条）
// const { ROTATION, SCALE_XY, ...keep } = el.manualKeyframeTracks || {};
// el.manualKeyframeTracks = keep;

// 方式三：清空全部手动关键帧
// el.manualKeyframeTracks = {};

return { mutatedNodeIds: [el.id], tracks: el.manualKeyframeTracks };
```

删除前向用户确认；清空全部轨道属于破坏性操作。

## 5. 颜色轨道（fills / strokes）

- 填充色轨道位于 `manualKeyframeTracks.fills`，键为 `node.fills` 中的**从 0 开始的 paint 下标**；描边色同理位于 `strokes`，对应 `node.strokes`。
- 只有 `SOLID` 类型的 paint 可以做颜色动画；渐变、图片不行。
- 值为 `{ type: "COLOR", value: { r, g, b, a } }`，分量 0–1。
- 写入前确保该下标的 paint 存在且为 SOLID；若需要新设 fills，注意这是对静态设计的修改，应事先征得同意。

```js
// 按钮背景在 0.3s 内从品牌蓝过渡到深蓝（下标 0 的填充）
const btn = await figma.getNodeByIdAsync("12:34");
const paints = btn.fills;
if (!Array.isArray(paints) || !paints[0] || paints[0].type !== "SOLID") {
  throw new Error("fills[0] 不存在或不是 SOLID，无法做颜色动画");
}
const hex = (h) => {
  const n = parseInt(h.replace("#", ""), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
};

const prev = btn.manualKeyframeTracks || {};
btn.manualKeyframeTracks = {
  ...prev,
  fills: {
    ...(prev.fills || {}),
    0: {
      keyframes: [
        { timelinePosition: 0, value: { type: "COLOR", value: hex("#2F6BFF") } },
        { timelinePosition: 0.3, value: { type: "COLOR", value: hex("#1C3F99") }, easing: { type: "LINEAR" } },
      ],
    },
  },
};
return { mutatedNodeIds: [btn.id], fillTracks: btn.manualKeyframeTracks.fills };
```

修改已有颜色轨道时同样保留轨道与关键帧的 `id`（`{ ...prev.fills[0], keyframes: ... }`）。描边把 `fills` 换成 `strokes` 即可。

## 6. 效果轨道（effects）

- 位于 `manualKeyframeTracks.effects`，先按 `node.effects` 的下标、再按效果字段名分组。写入前确保该下标的 effect 已存在。
- 可用字段：`OFFSET_X`、`OFFSET_Y`、`RADIUS`、`SPREAD`、`COLOR`、`SECONDARY_COLOR`、`EFFECT_OPACITY`、`REFRACTION_RADIUS`、`REFRACTION_INTENSITY`、`SPECULAR_ANGLE`、`SPECULAR_INTENSITY`、`CHROMATIC_ABERRATION`、`SPLAY`、`START_RADIUS`、`NOISE_SIZE_X`、`NOISE_SIZE_Y`、`DENSITY`。
- `COLOR`、`SECONDARY_COLOR` 用 COLOR 值；其余用 FLOAT。`SPECULAR_INTENSITY`、`CHROMATIC_ABERRATION`、`SPLAY`、`REFRACTION_INTENSITY` 取 0–1。
- `START_OFFSET_X/Y`、`END_OFFSET_X/Y` 不是公开字段，会抛错。

```js
// 卡片悬浮感：阴影（effects[0]）模糊半径与纵向偏移同时变大
const card = await figma.getNodeByIdAsync("12:34");
if (!card.effects || !card.effects[0]) throw new Error("effects[0] 不存在，请先确认卡片带阴影");
const f = (v) => ({ type: "FLOAT", value: v });
const ease = { type: "EASE_OUT" };

card.applyManualKeyframeTrack(
  { type: "INDEXED_ITEM", collection: "effects", index: 0, field: "RADIUS" },
  { keyframes: [{ timelinePosition: 0, value: f(8) }, { timelinePosition: 0.3, value: f(28), easing: ease }] },
);
card.applyManualKeyframeTrack(
  { type: "INDEXED_ITEM", collection: "effects", index: 0, field: "OFFSET_Y" },
  { keyframes: [{ timelinePosition: 0, value: f(2) }, { timelinePosition: 0.3, value: f(12), easing: ease }] },
);
return { mutatedNodeIds: [card.id], effectTracks: card.manualKeyframeTracks.effects };
```

## 7. 动画样式

动画样式是可复用的预制动画，写在 `node.animationStyles` 数组里，一个节点可以叠加多个。每个条目：

| 字段 | 位置 | 说明 |
|---|---|---|
| `styleId` | 顶层 | 样式定义 ID，来自 `figma.motion.figmaAnimationStyles()` |
| `name` | 顶层 | 显示名，必填 |
| `duration` | 顶层 | 本样式时长（秒） |
| `timelineOffset` | 顶层 | 开始时间（秒） |
| `id` | 顶层（回读） | 已套用实例的 ID，用于 `removeAnimationStyle` |
| `props` | 嵌套 | 样式专属参数，如 `timing`、`moveX`、`fade`、`easing`，因样式而异 |

`duration` 与 `timelineOffset` 是顶层字段，**不要**放进 `props`。

### 7.1 查询可用样式

```js
return figma.motion.figmaAnimationStyles().map((s) => ({
  styleId: s.styleId, name: s.name, description: s.description, props: s.props,
}));
```

`props` 返回的是参数**说明字符串**，只用来了解有哪些参数、默认值是什么；写缓动时用 `{ type: "EASE_OUT" }` 形式，不要照抄说明里的 `easingType: OUT_CUBIC`。

### 7.2 套用样式（推荐 `applyAnimationStyle`）

```js
// 给标题套用 Fade 入场，0.2s 后开始，持续 0.5s
const title = await figma.getNodeByIdAsync("12:34");
const fade = figma.motion.figmaAnimationStyles().find((s) => s.name === "Fade");
if (!fade) throw new Error("没有找到 Fade 样式，请先列出可用样式");

const start = 0.2, len = 0.5;
const instanceId = title.applyAnimationStyle(fade.styleId, {
  duration: len,
  timelineOffset: start,
  props: { timing: "in", easing: { type: "EASE_OUT" } },
});

const changed = [title.id];
const tl = title.timelines[0];
if (tl && tl.duration < start + len) {
  title.setTimelineDuration(tl.id, start + len);
  changed.push(tl.id);
}
return { mutatedNodeIds: changed, instanceId, styles: title.animationStyles, timelines: title.timelines };
```

也可以直接给数组赋值：`node.animationStyles = [...(node.animationStyles || []), { styleId, name, duration, timelineOffset, props }]`，但用辅助方法能直接拿到实例 `id`。

### 7.3 修改样式

```js
const el = await figma.getNodeByIdAsync("12:34");
el.animationStyles = (el.animationStyles || []).map((s) =>
  s.name === "Fade" ? { ...s, duration: 0.35, timelineOffset: 0 } : s);
return { mutatedNodeIds: [el.id], styles: el.animationStyles };
```

### 7.4 移除样式

```js
const el = await figma.getNodeByIdAsync("12:34");
const target = (el.animationStyles || []).find((s) => s.name === "Fade");
if (!target || !target.id) throw new Error("该节点上没有已套用的 Fade 样式");
el.removeAnimationStyle(target.id);
// 或：el.animationStyles = (el.animationStyles || []).filter((s) => s.name !== "Fade");
return { mutatedNodeIds: [el.id], styles: el.animationStyles };
```

### 7.5 校验

样式生成的轨道**目前不会出现在 `node.animations`**。校验样式写入请回读 `node.animationStyles`，不要看 `node.animations`。

## 8. 时间轴时长

- `node.timelines` 返回该节点所在顶层 frame 的时间轴 `[{ id, duration }]`，单位秒，只读。
- `node.setTimelineDuration(id, seconds)` 修改这条时间轴，`id` 必须是**同一节点**读出的那个。
- 规则：动画最晚结束时间 > 当前时长时才延长；从不主动缩短；把时间轴 `id` 加入 `mutatedNodeIds`。

```js
// 多个节点共享同一顶层 frame 时，统一计算所需时长后只设置一次
const ids = ["12:34", "12:35", "12:36"];
const nodes = (await Promise.all(ids.map((i) => figma.getNodeByIdAsync(i)))).filter(Boolean);
const need = 1.8; // 编排表中最晚的结束时间
const tl = nodes[0].timelines[0];
const changed = [];
if (tl && tl.duration < need) {
  nodes[0].setTimelineDuration(tl.id, need);
  changed.push(tl.id);
}
return { mutatedNodeIds: changed, timelines: nodes[0].timelines };
```

## 9. 变换坐标说明

- 变换值基于节点自身坐标系：位移单位像素，旋转单位度，缩放为倍率。
- `ROTATION` 与 `SCALE_*` 默认以节点**视觉中心**为轴心。
- 在自动布局容器中的子节点，用 `TRANSLATION_*` 做位移动画不会改变布局占位；用 `WIDTH`/`HEIGHT` 或 `STACK_*` 间距动画则会带动兄弟节点重排，选择时注意。

## 10. 常用动效配方

以下配方都是"关键帧计划"，可组合使用。`f(v)` 表示 `{ type: "FLOAT", value: v }`。

### 10.1 淡入 + 上移入场

- `OPACITY`：t0 → 0，t0+0.4 → 1，`EASE_OUT`
- `TRANSLATION_Y`：t0 → 24，t0+0.5 → 0，`EASE_OUT` 或强减速贝塞尔

### 10.2 缩放弹出（弹窗、徽标）

- `OPACITY`：0 → 1，0.2s，`EASE_OUT`
- `SCALE_XY`：0.85 → 1，0.4s，`EASE_OUT_BACK` 或 `CUSTOM_SPRING` bounce 0.25

### 10.3 列表 / 卡片错峰入场（stagger）

每个元素相同的动画，起始时间按 50–100ms 递增，总时长控制在 1s 左右：

```js
// 对一个容器内的直接子节点做错峰淡入上移
const box = await figma.getNodeByIdAsync("12:30");
if (!box || !("children" in box)) throw new Error("容器不存在或没有子节点");
const f = (v) => ({ type: "FLOAT", value: v });
const gap = 0.08, len = 0.45, rise = 24;
const out = { type: "EASE_OUT" };
const changed = [];
let lastEnd = 0;

box.children.forEach((child, i) => {
  const t0 = i * gap, t1 = t0 + len;
  child.applyManualKeyframeTrack({ type: "PROPERTY", name: "OPACITY" }, {
    keyframes: [{ timelinePosition: t0, value: f(0) }, { timelinePosition: t1, value: f(1), easing: out }],
  });
  child.applyManualKeyframeTrack({ type: "PROPERTY", name: "TRANSLATION_Y" }, {
    keyframes: [{ timelinePosition: t0, value: f(rise) }, { timelinePosition: t1, value: f(0), easing: out }],
  });
  changed.push(child.id);
  lastEnd = Math.max(lastEnd, t1);
});

const tl = box.children[0] && box.children[0].timelines[0];
if (tl && tl.duration < lastEnd) {
  box.children[0].setTimelineDuration(tl.id, lastEnd);
  changed.push(tl.id);
}
return { mutatedNodeIds: changed, lastEnd };
```

注意 `box` 本身若是顶层 frame 也没关系——动画加在它的子节点上。首帧保持规则保证了每个子节点在自己的起始时间之前一直处于隐藏态。

### 10.4 层级编排（hero 区）

按信息层级依次出现：标题（0s）→ 副标题（+0.12s）→ 主按钮（+0.24s）→ 次要内容（+0.36s）。每个元素用 10.1 的配方；越次要的元素位移越小。

### 10.5 强调 / 脉冲

- `SCALE_XY`：0 → 1，0.15 → 1.08（`EASE_OUT`），0.35 → 1（`EASE_IN_AND_OUT`）
- 需要"重复几次"时在时间轴内写多组关键帧；没有确认可用的循环设置 API 时，不要承诺"无限循环"，在交付中说明。

### 10.6 抖动（错误提示）

`TRANSLATION_X`：0 → -10 → 10 → -6 → 6 → 0，每段约 0.06s，`EASE_IN_AND_OUT`，总长约 0.35s。

### 10.7 描线（图标、签名、路径）

对 vector 节点：`PATH_TRIM_END` 从 0 → 1，0.8–1.2s，`EASE_IN_AND_OUT`；配合 `PATH_TRIM_START` 可做"线段追逐"。

### 10.8 颜色 / 状态切换

- 平滑过渡：fills 颜色轨道，0.2–0.3s，`LINEAR` 或 `EASE_IN_AND_OUT`（见 §5）。
- 生硬切换：同一颜色轨道，末帧缓动用 `HOLD`。

### 10.9 展开 / 折叠

- 容器 `HEIGHT`：收起值 → 展开值，0.3–0.4s，`EASE_IN_AND_OUT`（group/vector 不可用）；
- 内容 `OPACITY` 晚 0.1s 开始，避免文字在容器变高过程中被挤压。

### 10.10 加载旋转

`ROTATION`：0 → -360（顺时针一圈），1s，`LINEAR`。多圈就用 -720、-1080 并相应延长时间轴。

### 10.11 离场

`OPACITY` 1 → 0 配合轻微 `TRANSLATION_Y` 0 → -12 或 `SCALE_XY` 1 → 0.96，0.2–0.3s，`EASE_IN`。离场比入场短。

### 10.12 逐字 / 逐项揭示

多个文字节点的 `OPACITY` 轨道：隐藏值在前，到达各自时间点时用 `HOLD` 跳变为 1，间隔 0.05–0.1s。

## 11. 动效设计默认值

用户没有要求强烈效果时保持克制：

- 时长多在 **0.25–0.7s**；
- 相关元素**错峰**出现，不要同时动；
- 用出现顺序表达层级：标题 → 副标题 → 主内容 → 次要内容；
- 优先 `EASE_OUT`、`EASE_IN_AND_OUT`、`GENTLE`、`QUICK`；
- 避免花哨循环、大角度旋转和过度弹跳，除非用户明确要求；
- 一次只让一两个属性变化（通常透明度 + 位移/缩放），多属性同时剧烈变化会显得廉价。

## 12. 常见坑速查

| 坑 | 正确做法 |
|---|---|
| 给顶层 frame 加动画 | 加在子孙节点上 |
| 用毫秒写时间 | 全部用秒 |
| `EASE_IN_OUT` / `OUT_CUBIC` | `EASE_IN_AND_OUT` / `EASE_OUT` |
| 把位移写成目标坐标 | 位移是相对静止态的增量 |
| 缩放写 0 表示"不变" | 缩放中性值是 1 |
| 以为正角度是顺时针 | 正值逆时针，顺时针用负值 |
| 整体赋值覆盖了其他轨道 | 先 `...prev` 展开旧值，或用 `applyManualKeyframeTrack` |
| 编辑时丢了 id / baseValue | 用 `{ ...track, keyframes: ... }` 保留 |
| 新建轨道手写 baseValue | 省略，由 API 推导 |
| 在不存在或非 SOLID 的 paint 上做颜色动画 | 先检查 `node.fills[i].type === "SOLID"` |
| 在不存在的 effect 上写轨道 | 先检查 `node.effects[i]` |
| 在 group / vector 上用 WIDTH/HEIGHT | 改用 `SCALE_*` |
| `duration` 放进 `props` | `duration`、`timelineOffset` 是顶层字段 |
| 用 `node.animations` 校验样式 | 回读 `node.animationStyles` |
| 动画超出时间轴被截断 | 计算最晚结束时间，必要时 `setTimelineDuration` |
| 主动缩短了时间轴 | 只延长，不缩短 |
| 用截图判断动画正确 | 截图只有静止态；用 `export_video` 抽帧或核对数据 |
| 遇到 not a supported API 反复重试 | 立即停止，告知用户未开通 |
