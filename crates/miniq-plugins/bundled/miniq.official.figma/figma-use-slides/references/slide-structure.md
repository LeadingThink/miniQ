# 幻灯片结构：生命周期、网格与属性

> 属于 `figma-use-slides` 技能。涵盖：创建/复制/删除/排序幻灯片与行（分节），`SlideGrid`/`SlideRow` 网格结构，幻灯片级属性（尺寸、跳过、聚焦、讲者备注、主题、交互元素、过渡）及已知限制。所有写操作都要 `return` 被创建/修改的节点 ID。

## 目录

1. 结构模型
2. 读取网格与盘点 deck
3. 新文件的空网格
4. 创建幻灯片与行
5. 复制幻灯片
6. 删除幻灯片
7. 排序与移动（`setSlideGrid`）
8. 分节（行命名）
9. 幻灯片属性：尺寸、跳过、聚焦、讲者备注、主题
10. 交互元素
11. 过渡与其他已知限制

---

## 1. 结构模型

```
PAGE（Slides 文件只有一个页面，不能 createPage）
└── SLIDE_GRID           不透明节点；只有 children（各行）
    ├── SLIDE_ROW        不透明节点；children 为该行的幻灯片；name 可写 = 分节名
    │   ├── SLIDE        完整 frame 能力：fills、children、自动布局、screenshot…
    │   └── SLIDE
    └── SLIDE_ROW
        └── SLIDE
```

- 行 = 分节（section）。未命名的行在界面中显示默认标签 "Section"。
- 播放顺序：按行从上到下、行内从左到右。
- 网格在编辑器中有内边距（`GRID_PADDING` = 240），这正是"先设坐标再挂载"会偏移 240 的根源（见 `slide-gotchas.md`）。

## 2. 读取网格与盘点 deck

`figma.getSlideGrid()` 返回 `SlideNode[][]`（二维数组，外层为行、内层为该行的幻灯片）。**内层是普通 JS 数组，不是 `SLIDE_ROW` 节点。**

盘点整个 deck（只读，改稿前先跑）：

```js
const rows = figma.getSlideGrid();
const inventory = rows.flatMap((row, r) =>
  row.map((s, c) => ({
    id: s.id,
    name: s.name,
    row: r,
    col: c,
    skipped: s.isSkippedSlide,
    notes: s.speakerNotes,
    size: `${Math.round(s.width)}x${Math.round(s.height)}`,
  }))
);
const gridNode = figma.currentPage.children.find(n => n.type === "SLIDE_GRID");
const sections = gridNode ? gridNode.children.map((row, i) => ({ index: i, id: row.id, name: row.name, count: row.children.length })) : [];
return { total: inventory.length, sections, slides: inventory };
```

读取某页全部文字（字体可能混用，先加载再读更稳妥；只读时也可只取 `characters`）：

```js
const slide = await figma.getNodeByIdAsync("SLIDE_ID");
const texts = slide.findAllWithCriteria({ types: ["TEXT"] });
return texts.map(t => ({
  id: t.id,
  name: t.name,
  text: t.characters,
  size: t.fontSize === figma.mixed ? "mixed" : t.fontSize,
  font: t.fontName === figma.mixed ? "mixed" : `${t.fontName.family} ${t.fontName.style}`,
  box: [Math.round(t.x), Math.round(t.y), Math.round(t.width), Math.round(t.height)],
}));
```

## 3. 新文件的空网格

`create_new_file` 新建的 Slides 文件：

- `figma.getSlideGrid()` 返回 `[]`——**没有默认首页**，0 行 0 页；
- 页面下唯一的子节点是空的 `SLIDE_GRID`（ID 通常为 `0:3`）；
- 第一次 `figma.createSlide()` 会隐式创建第 0 行并把新页放进去；之后无参调用追加到最后一行末尾；
- 文件带默认浅色主题，但它只是脚手架，按本 deck 的设计覆盖。

脚本若假设"至少有一页"（例如要从首页读主题色），必须处理空网格：

```js
let rows = figma.getSlideGrid();
if (rows.length === 0) {
  figma.createSlide();
  rows = figma.getSlideGrid();
}
const first = rows[0][0];
return { firstSlideId: first.id, w: first.width, h: first.height };
```

## 4. 创建幻灯片与行

```js
// 追加到 deck 末尾（最后一行的最后）
const tail = figma.createSlide();

// 指定位置：第 1 行（0 起算）第 0 列
const inserted = figma.createSlide(1, 0);

// 新建一行（分节）：无参追加到末尾；传索引则插入到该位置
const newRow = figma.createSlideRow();      // 末尾
const introRow = figma.createSlideRow(0);   // 成为第一行
introRow.name = "开场";

// 新行初始为空，用 createSlide(行索引, 列索引) 往里放
const cover = figma.createSlide(0, 0);
cover.name = "封面";

return { createdNodeIds: [tail.id, inserted.id, newRow.id, introRow.id, cover.id] };
```

- `createSlide` 返回 `SlideNode`，自动挂入网格，无需 `appendChild`。
- 创建后立即 `name` 命名（如 `"01 封面"`），方便后续按名查找和汇报。
- 注意：插入行会让其后的行索引 +1，连续插入时按从后往前的顺序或每次重新读取网格。

## 5. 复制幻灯片

```js
const src = await figma.getNodeByIdAsync("SLIDE_ID");
const dup = src.clone();
dup.name = `${src.name}（副本）`;

// clone 的结果默认挂在当前页面，不在期望位置；用 setSlideGrid 放到原页之后
const rows = figma.getSlideGrid().map(row => row.filter(s => s.id !== dup.id));
const r = rows.findIndex(row => row.some(s => s.id === src.id));
const c = rows[r].findIndex(s => s.id === src.id);
rows[r].splice(c + 1, 0, dup);
figma.setSlideGrid(rows);
return { createdNodeIds: [dup.id], placedAt: { row: r, col: c + 1 } };
```

- `SLIDE_GRID` 本身不能 `clone()`（运行时抛错）。
- 复制后记得修改副本中的文字内容，否则会出现两页完全相同的内容。

## 6. 删除幻灯片

```js
const ids = ["SLIDE_ID_A", "SLIDE_ID_B"];
const nodes = await Promise.all(ids.map(id => figma.getNodeByIdAsync(id)));
const removed = [];
for (const n of nodes) {
  if (n && n.type === "SLIDE") { removed.push({ id: n.id, name: n.name }); n.remove(); }
}
return { removed };
```

- 删除后网格自动更新；一行的页全删光后，**该空行仍然保留**。需要清理空行时，用 `setSlideGrid` 传入过滤掉空数组后的网格（见下一节）。
- 删除是破坏性操作：只在用户明确要求时执行，执行前列出将删除的页名请用户确认；"改版/优化"不等于删除重建。

## 7. 排序与移动（`setSlideGrid`）

`figma.setSlideGrid(rows)` 接收新的二维数组，可自由调整分组与顺序，但**必须包含当前所有幻灯片**，不能借此丢弃页（要删页请用 `remove()`）。

```js
// 把某页移到指定行的指定位置，并清掉因此变空的行
const MOVE_ID = "SLIDE_ID", TO_ROW = 2, TO_COL = 0;
const target = await figma.getNodeByIdAsync(MOVE_ID);
let rows = figma.getSlideGrid().map(row => row.filter(s => s.id !== MOVE_ID));
rows[TO_ROW].splice(TO_COL, 0, target);
rows = rows.filter(row => row.length > 0);
figma.setSlideGrid(rows);
return { order: figma.getSlideGrid().map(row => row.map(s => s.name)) };
```

```js
// 所有页合并为一行（取消分节）
figma.setSlideGrid([figma.getSlideGrid().flat()]);
```

```js
// 按页名排序（如 "01 …"、"02 …" 编号），保持现有分节结构
const rows = figma.getSlideGrid().map(row => [...row].sort((a, b) => a.name.localeCompare(b.name, "zh")));
figma.setSlideGrid(rows);
```

```js
// 按页数重新切分为若干节：sizes = [2, 4, 3] 表示第一节 2 页、第二节 4 页……
const sizes = [2, 4, 3];
const all = figma.getSlideGrid().flat();
if (sizes.reduce((a, b) => a + b, 0) !== all.length) return { error: "分节页数之和与总页数不一致" };
let k = 0;
figma.setSlideGrid(sizes.map(n => all.slice(k, (k += n))));
return { rows: figma.getSlideGrid().map(r => r.length) };
```

- `getSlideGrid`/`setSlideGrid` 在类型定义中被标为 deprecated（推荐 `getCanvasGrid`/`setCanvasGrid`），但在 Slides 中两者都可用。
- 重排后用 `getSlideGrid()` 读回并 `return` 新顺序作为校验。
- 重排可能改变行节点：给分节命名放在重排**之后**，并重新从 `SLIDE_GRID.children` 取行。

## 8. 分节（行命名）

- 分节名显示在编辑器行旁，并在演讲者视图中用于在分节间跳转。
- **必须写在真实的 `SLIDE_ROW` 节点上**，通过 `SLIDE_GRID.children` 获取；给 `getSlideGrid()` 的内层数组设 `.name` 静默无效。
- `SLIDE_ROW` 其他属性（填充、特效、布局）不可访问，只有 `name` 可写。

```js
const gridNode = figma.currentPage.children.find(n => n.type === "SLIDE_GRID");
const plan = { 0: "开场", 1: "现状", 2: "方案", 3: "下一步" };
const out = [];
gridNode.children.forEach((row, i) => {
  if (plan[i]) row.name = plan[i];
  out.push({ id: row.id, name: row.name, slides: row.children.map(s => s.name) });
});
return { sections: out };
```

命名原则见 SKILL.md "分节"一节：1–3 个词、具体、风格统一，通常 2–5 节。

## 9. 幻灯片属性

### 尺寸

- 幻灯片画布尺寸固定，通常为 **1920×1080**（16:9）。以 `slide.width`/`slide.height` 为准，布局前先读取，不要硬编码假设其他尺寸。
- 页内内容用相对幻灯片左上角的 `x`/`y` 定位；幻灯片不是自动布局容器。

### `isSkippedSlide`：播放时跳过

```js
const s = await figma.getNodeByIdAsync("SLIDE_ID");
const before = s.isSkippedSlide;
s.isSkippedSlide = true;     // 放映时跳过；设 false 取消
return { id: s.id, before, after: s.isSkippedSlide };
```

典型用途：备用页、附录、按场合隐藏的页。跳过的页仍保留在网格中。

### `focusedSlide` / `focusedNode`：页面级聚焦

它们是 `PageNode`（`figma.currentPage`）的属性，不是 `SlideNode` 的。

```js
const cur = figma.currentPage.focusedSlide;          // 当前聚焦的幻灯片（可能为 null）
const target = await figma.getNodeByIdAsync("SLIDE_ID");
figma.currentPage.focusedSlide = target;             // 让编辑器切到该页
const fn = figma.currentPage.focusedNode;            // 当前聚焦的任意可聚焦节点
return {
  previous: cur ? cur.id : null,
  now: figma.currentPage.focusedSlide.id,
  focusedNode: fn ? { id: fn.id, type: fn.type } : null,
};
```

### `speakerNotes`：讲者备注

- 值为 **markdown 字符串**；未设置时为 `""`；设为 `""` 即清空。
- 支持的格式：无序列表（`- ` 或 `* `）、有序列表（`1. `）、粗体 `**…**`、斜体 `*…*`、粗斜体 `***…***`、删除线 `~~…~~`。
- **不支持**（会原样显示符号）：标题 `#`、行内代码与代码块、链接 `[文字](url)`、下划线。

```js
const s = await figma.getNodeByIdAsync("SLIDE_ID");
s.speakerNotes = [
  "- 先抛问题：**为什么上季度流失集中在第二周？**",
  "- 数据来自内部看板，*尚未对外公开*",
  "- 过渡：\u201c所以我们做了三件事\u201d → 下一页",
].join("\n");
return { id: s.id, notes: s.speakerNotes };
```

内容写法（何时写、写什么、避免什么）见 `slide-content.md`。

### `slideThemeId`：主题

- 只读，用于识别某页所应用的主题；主题操作 API 有限。
- 新文件的默认浅色主题只是起点：需要统一改风格时，直接设置页面背景 `fills`、文字样式与颜色（或修改文件中的颜色变量/文字样式），并在所有相关页上保持一致。

## 10. 交互元素 `InteractiveSlideElementNode`

幻灯片中嵌入的投票、嵌入内容等交互元素：**只能检测和读取，不能通过 Plugin API 创建**。

```js
const s = await figma.getNodeByIdAsync("SLIDE_ID");
const items = s.findAllWithCriteria({ types: ["INTERACTIVE_SLIDE_ELEMENT"] });
return items.map(n => ({ id: n.id, kind: n.interactiveSlideElementType }));
```

`interactiveSlideElementType` 可能值：`POLL`、`EMBED`、`FACEPILE`、`ALIGNMENT`、`YOUTUBE`。用户要求添加这类元素时，说明需要在编辑器 UI 中手动插入。

## 11. 过渡与其他已知限制

| 能力 | 状态 | 替代方案 |
|---|---|---|
| `getSlideTransition()` / `setSlideTransition()` | 类型中声明，运行时抛 "not implemented" | 请用户在编辑器中为幻灯片设置过渡；可在交付说明中给出建议（如"章节页用 Smart Animate"） |
| `SlideGridNode.clone()` | 运行时抛错 | 逐页 `clone()` 后用 `setSlideGrid` 排列 |
| `figma.createPage()` | 抛 `TypeError` | 用行（分节）组织结构 |
| `figma.createTable()` / `figma.createGif()` | Slides 模式被屏蔽（编辑器本身支持表格和媒体） | 编辑器 UI 手动添加；简单表格可用形状+文字模拟 |
| 主题操作 | `slideThemeId` 只读，操作 API 有限 | 直接改填充、文字样式、颜色变量 |
| 交互元素 | 只读 | 编辑器 UI 手动添加 |
| 图片 | 不能用 `createImage`/`createImageAsync` 作为上传入口 | 用 `upload_assets` 工具 |
