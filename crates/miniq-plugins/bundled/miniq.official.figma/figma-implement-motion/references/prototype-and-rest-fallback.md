# 原型交互、Smart Animate 与变体过渡：REST 与用户规格回退

`get_motion_context` 只覆盖**关键帧时间线动画**。原型连线（点击/悬停/延时跳转）、Smart Animate、组件变体之间的切换，走的是另一条数据通路，MCP 目前不返回（对应 lint L-PROTO，措辞见 [motion-lint-rules.md](motion-lint-rules.md)）。本文说明如何从 REST 节点 JSON 或用户口述中拿到规格，并还原为代码。

返回 [../SKILL.md](../SKILL.md)。

## 一、取数据：借助 `figma-rest-export`

读取并遵循 `figma-rest-export` 技能（`skill_read`）拿到节点 JSON，本技能不重复其令牌与导出步骤。要点：

- 取**发起交互的帧/实例**及**目标帧/变体**两端的节点 JSON；`depth` 要够深，交互常挂在子实例上。
- 变体过渡还需要**组件集**（COMPONENT_SET）节点，以便对比各变体属性差异。
- 然后运行本技能脚本汇总交互：

```bash
python3 <本技能目录>/scripts/extract_interactions.py /tmp/figma-node.json            # 文本
python3 <本技能目录>/scripts/extract_interactions.py /tmp/figma-node.json --format markdown
```

脚本只读，输出每条交互的“节点 → 触发 → 动作 → 目标 → 过渡类型 → 时长 → 缓动”，并给出 CSS 与 motion.dev 写法建议。退出码 1 表示没找到交互（可能 depth 不够）。

## 二、REST 字段速查

新版字段位于节点的 `interactions` 数组，每项含 `trigger` 与 `actions`：

| 字段 | 含义 | 实现提示 |
|---|---|---|
| `trigger.type` | `ON_CLICK`、`ON_HOVER`、`ON_PRESS`、`ON_DRAG`、`AFTER_TIMEOUT`、`MOUSE_ENTER`/`MOUSE_LEAVE`、`ON_KEY_DOWN` 等 | 分别对应 click、`:hover`/`onHoverStart`、`:active`/`whileTap`、拖拽手势、`setTimeout`、指针进出、键盘事件 |
| `trigger.timeout` / `trigger.delay` | 延时（秒） | `AFTER_TIMEOUT` 用定时器，组件卸载时清除 |
| `actions[].type` | `NODE`（跳转/切换）、`BACK`、`CLOSE`、`URL`、`SET_VARIABLE`、`CONDITIONAL` 等 | `URL` 视为外链，不可信，需确认后再写入代码 |
| `actions[].navigation` | `NAVIGATE`（换页）、`CHANGE_TO`（切换变体）、`OVERLAY`、`SWAP`、`SCROLL_TO` | `CHANGE_TO` = 组件内部状态切换；`OVERLAY` = 弹层/抽屉 |
| `actions[].destinationId` | 目标节点 id | 目标帧/变体的静态结构用 `figma-design-to-code` 另行还原 |
| `transition.type` | `DISSOLVE`、`SMART_ANIMATE`、`MOVE_IN`/`MOVE_OUT`、`PUSH`、`SLIDE_IN`/`SLIDE_OUT`、`SCROLL_ANIMATE` 等 | 见第三节映射 |
| `transition.direction` | `LEFT`/`RIGHT`/`TOP`/`BOTTOM` | 决定进出方向 |
| `transition.matchLayers` | 滑动/推入时是否同时匹配同名图层 | 为真时同名元素走 Smart Animate 式插值 |
| `transition.duration` | 时长，**秒** | motion.dev 直接用；CSS 可写 `s` 或换算 ms |
| `transition.easing.type` | `LINEAR`、`EASE_IN`、`EASE_OUT`、`EASE_IN_AND_OUT`、`*_BACK`、`CUSTOM_CUBIC_BEZIER`、`GENTLE`/`QUICK`/`BOUNCY`/`SLOW`（弹簧预设）、`CUSTOM_SPRING` | 自定义值在 `easingFunctionCubicBezier{x1,y1,x2,y2}` 或 `easingFunctionSpring{mass,stiffness,damping}` 中 |

旧版字段（仍可能出现）：`transitionNodeID`（目标）、`transitionDuration`（**毫秒**）、`transitionEasing`（缓动枚举）。注意两套字段的时长单位不同。

预设缓动的具体控制点/弹簧参数，JSON 中若带了自定义值就用 JSON 的；只给了枚举名时脚本给出常见近似值并标注“请核对”，汇报里也要说明。

## 三、过渡类型到代码的映射

| Figma 过渡 | Web（motion.dev） | Web（CSS） |
|---|---|---|
| 即时（无 transition） | 直接切换状态 | 无过渡 |
| `DISSOLVE` | `AnimatePresence` + `opacity` 交叉淡化 | 两层叠放，`opacity` 过渡 |
| `SMART_ANIMATE` | 同名图层在两个状态间插值：同一组件内用条件样式 + `animate`；跨布局用 `layout` / `layoutId` | 同一 DOM 元素上切换类名，对变化的 `transform`/`opacity`/颜色加 `transition` |
| `MOVE_IN` / `MOVE_OUT` | 新内容从 `direction` 方向 `x`/`y` 平移进入（旧内容不动） | `transform: translate…` 过渡 |
| `PUSH` | 新旧内容同向平移，旧内容被推出 | 两层同时平移 |
| `SLIDE_IN` / `SLIDE_OUT` | 类似 MOVE，但伴随轻微位移与淡化 | `translate` + `opacity` |
| `OVERLAY` 导航 | 弹层 + 背景遮罩，`AnimatePresence` 管理退出动画 | `dialog`/弹层 + 过渡；记得焦点管理与 Esc 关闭 |

缓动映射：贝塞尔 → CSS `cubic-bezier(...)` / motion.dev `ease: [x1,y1,x2,y2]`；弹簧 → motion.dev `type: "spring"` 配 `mass`/`stiffness`/`damping`（或其它库的 spring 原语），**不要**用 cubic-bezier 近似；纯 CSS 场景可用 `linear()` 对弹簧曲线采样并注明近似。SwiftUI/Compose 映射见 [framework-recommendations.md](framework-recommendations.md)。

## 四、从变体差异重建 Smart Animate

REST 能提供两个变体的完整属性，但不告诉你“怎么插值”——Smart Animate 的规则是**同名图层**在两状态间插值位置、尺寸、旋转、透明度、填充色、圆角等。

1. 取源变体和目标变体的节点 JSON，按**图层名路径**配对子节点（不是按 id，变体间 id 不同）。
2. 逐对比较：`absoluteBoundingBox`（位置/尺寸）、`rotation`、`opacity`、`fills`、`cornerRadius`、`effects`、`visible`。
3. 只给**有差异**的属性加过渡；只在一侧存在的图层 → 淡入/淡出。
4. 时长与缓动取自连向该变体的交互 `transition`；没有交互数据时不要编，走第五节询问。
5. 实现上尽量让两个变体是**同一组 DOM 元素的不同状态**（类名/props 切换），而不是渲染两棵树再交叉淡化——前者才是 Smart Animate 的效果。
6. 尺寸变化优先用 transform 或 motion.dev `layout`，避免直接动画 `width`/`height`（`motion_lint.py` ML002 会提示）。

自写示例（开关组件，变体 `State=Off` → `State=On`，交互给出 0.25s、`EASE_OUT`）：

```tsx
import { motion, useReducedMotion } from "motion/react";

const SWITCH_T = { duration: 0.25, ease: [0, 0, 0.58, 1] as const }; // 来自交互 transition

export function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const reduce = useReducedMotion();
  const t = reduce ? { duration: 0 } : SWITCH_T;
  return (
    <motion.button
      role="switch"
      aria-checked={on}
      onClick={onToggle}
      className="relative h-6 w-10 rounded-full"
      animate={{ backgroundColor: on ? "#22c55e" : "#d4d4d8" }}   // 变体间 fills 差异
      transition={t}
    >
      <motion.span
        className="absolute left-0.5 top-0.5 size-5 rounded-full bg-white"
        animate={{ x: on ? 16 : 0 }}                                 // 变体间 x 差异
        transition={t}
      />
    </motion.button>
  );
}
```

## 五、没有数据时向用户询问

REST 不可用、没有令牌或交互未定义时，用 `ask_user` 获取规格，不要自行假设。模板：

> 设计中的「<组件/帧名>」包含原型交互（<触发，如点击/悬停>），但 Figma MCP 目前无法读取这类过渡的参数。请提供以下任一项：
> 1. 过渡参数：类型（淡入 / Smart Animate / 推入 / 滑入…）、时长（毫秒）、缓动（名称或 cubic-bezier / 弹簧参数）
> 2. 配置 `FIGMA_TOKEN`，让我通过 REST 读取交互数据
> 3. 接受近似实现：我将用 200ms、ease-out 做基础过渡，并在代码中标注“近似”

用户选 3 时，在代码注释和汇报中都写明哪些值是近似的。

## 六、校验

- 用 `browser_automation` 触发交互（点击、悬停、等待超时），截图对比过渡前后两个状态与 Figma 变体截图（`get_screenshot`）。
- 检查 `prefers-reduced-motion` 下状态仍然正确切换，只是没有（或极短的）过渡。
- 键盘可达：原型里的点击交互在代码里要有可聚焦元素与键盘触发。

## 相关

- [unsupported-and-fallbacks.md](unsupported-and-fallbacks.md)
- [framework-recommendations.md](framework-recommendations.md)
- [gotchas.md](gotchas.md)
