# 动效 lint 规则

两部分：
- **A. 导出限制规则**：Figma 动效导出的已知限制。设计命中时，必须把对应的**固定措辞**告诉用户。
- **B. 代码检查规则**：`scripts/motion_lint.py` 对实现代码的启发式检查（ML001–ML010）。

返回 [../SKILL.md](../SKILL.md)。

---

## A. 导出限制规则

### 级别

- **错误（Error）**：该特性无法生成代码。告诉用户哪里不支持、为什么；**不要**自行手写一个替代品冒充设计效果（可以在用户同意后按 [unsupported-and-fallbacks.md](unsupported-and-fallbacks.md) 做明确标注的近似）。
- **警告（Warning）**：代码可以生成但存在已知差距。照常交付代码，同时说明可能与设计不一致的地方。

### 固定措辞

每条规则下方引用块是给用户的**固定措辞**。请逐字使用（可以附加你自己的补充说明，但不要改写这段话本身），以保证每次会话的说法一致。

### 覆盖规则：只对“错误”生效

如果某条错误规则说“无法生成”，但 `get_motion_context` 实际返回了该特性的有效代码，说明限制已解除——跳过该错误，使用工具输出。**警告即使在返回了代码时也仍然适用**，因为警告描述的正是生成代码中的差距。

### L-PROTO：原型交互 / Smart Animate / 变体过渡 —— 错误

> **固定措辞：**
> 目前 Figma MCP 不提供原型交互数据。画布上的时间轴关键帧可以读取，但帧与帧之间的 Smart Animate 过渡及其过渡设置（触发方式、时长、缓动）无法获取。基于此选区生成的代码只包含起始状态和结束状态，不包含两者之间的过渡。

补充：可按 [prototype-and-rest-fallback.md](prototype-and-rest-fallback.md) 从 REST 节点 JSON 的 `interactions` 字段或用户规格重建过渡，并明确标注“数据来自 REST/用户规格”。

### L-ANIMATED-EXPORT：GIF / 动画 SVG 导出 —— 错误

> **固定措辞：**
> 目前 Figma MCP 不支持导出 GIF 或动画 SVG。矢量图层只会导出为各自独立的静态 SVG，不附带任何动效数据。如需动态位图，请改用视频导出；如需动态矢量，请把这些静态 SVG 引入运行时（如 Motion.dev、Lottie），再按动效上下文中的关键帧重新施加动画。

### W-CONTENTS：分组被输出为 display: contents —— 警告

> **固定措辞：**
> 生成的结构会给 Figma 分组节点加上 `display: contents`，使分组自身的盒子从布局中消失。我们已尝试修正，但修正可能引入其它布局问题；作用在分组上的动画可能无法按预期呈现。

处理方法见 [gotchas.md](gotchas.md) 中“动画挂在 display: contents 分组上”。

---

## B. 代码检查规则（motion_lint.py）

用法：

```bash
python3 scripts/motion_lint.py --help
python3 scripts/motion_lint.py --list-rules
python3 scripts/motion_lint.py --git-diff [--base origin/main]      # 只查改动与新增文件
python3 scripts/motion_lint.py src/components --format json --fail-on warning
```

- 只读，不修改文件；只依赖 Python 3 标准库。
- 默认遇到 error 级别时退出码为 1（`--fail-on never` 可关闭）。
- 项目已在根组件（`<MotionConfig reducedMotion="user">`）或全局 CSS 统一处理减少动效时，加 `--global-reduced-motion` 跳过 ML001。

| 规则 | 级别 | 检查内容 | 如何修 |
|---|---|---|---|
| ML001 | error | 文件里有动效（`@keyframes`、`animation`、`transition`、`<motion.*>`、`gsap.` 等），却没有任何减少动效处理 | 加 `@media (prefers-reduced-motion: reduce)`、`useReducedMotion()`、`MotionConfig reducedMotion`，或 Tailwind `motion-safe:`/`motion-reduce:` |
| ML002 | warning | 对 width/height/top/left/margin/padding 等布局属性做过渡或关键帧 | 能用 `transform`/`opacity` 表达就改；设计确实是尺寸变化时保留，并说明原因（或用 motion 的 `layout` 动画） |
| ML003 | error | `display: contents` 元素上挂动效 | 分组在动 → 换成有真实盒子的定位包裹层；分组不动 → 移除动效 |
| ML004 | warning | 同一元素既有 Tailwind `-translate-x-1/2`/`rotate-*`/`scale-*` 类，又有 Motion 的 `x/y/rotate/scale` | 拆成“静态定位外层 + 内层 motion 元素”，或把偏移写进 Motion（`x: "-50%"` 并在每个关键帧保留） |
| ML005 | warning | `duration: 0` 或 `0s`/`0ms` 的动画 | 直接写终态静态样式，不生成动画块 |
| ML006 | warning | 同一时长/缓动/`cubic-bezier` 字面量在文件中出现 ≥3 次（`--min-repeat` 可调） | 提取常量、`variants` 或共享组件；数值不变 |
| ML007 | warning | `transition: all` / `transition-all` | 列出具体属性 |
| ML008 | warning | `will-change` 过多（默认 >3 处）或挂在 `*`/`html`/`body`/`:root` | 只给正在动画的元素加，结束后移除 |
| ML009 | info | motion 元素对 scale/rotate 做动画但未写 `transformOrigin`/`originX`/`originY` | 对照动效上下文确认原点；设计原点非中心时必须写 |
| ML010 | warning | 命名/注释显示是 spring/bouncy/gentle，却用 `cubic-bezier` 实现 | 改用库的 spring 原语（见 [framework-recommendations.md](framework-recommendations.md)） |

局限：基于正则的启发式扫描，不解析 AST；跨文件的全局减少动效、动态拼接的类名、CSS-in-JS 模板字符串中的部分写法可能漏报或误报。每条结果都要人工判断，并在汇报中说明处理结论。

## 相关

- [gotchas.md](gotchas.md) —— 各类坑的技术修法
- [unsupported-and-fallbacks.md](unsupported-and-fallbacks.md) —— 不支持项的回退方案
