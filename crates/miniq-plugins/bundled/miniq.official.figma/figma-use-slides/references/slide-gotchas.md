# Slides 常见坑与防御写法

> 属于 `figma-use-slides` 技能。通用 Plugin API 坑见 `figma-use` 技能，这里只列 Slides 特有或在 Slides 中特别容易触发的问题。

## 目录

1. 先挂载后定位（最关键）
2. 偏移问题的诊断
3. 辅助函数与代码前导模板
4. 字体加载：主题字体与现有文本
5. 独立的异步调用要批量 `await`
6. 用索引查询代替全树扫描，并缩小遍历范围
7. `SLIDE_GRID` / `SLIDE_ROW` 是不透明节点
8. 其他会直接抛错或静默失败的 API
9. 没有 `get_metadata` 时如何校验
10. 批量校验脚本与校验节奏

---

## 1. 先挂载后定位（最关键）

**规则**：任何节点，在它被 `appendChild` 到**最终父节点之后**，再设置 `x`/`y`；尺寸、填充等属性也建议挂载后再设。规则适用于每一层嵌套：卡片挂到幻灯片、文字挂到卡片、图标挂到文字行……都一样。

**原因**：在 Slides 文件里，`figma.createFrame()` / `createRectangle()` / `createText()` 等新建节点会被隐式挂到一个幻灯片上下文，其原点位于绝对坐标 `(240, 240)`（网格的 `GRID_PADDING`）。此时写 `x = 300`，引擎按绝对坐标理解，内部存成相对值 `300 − 240 = 60`；随后再挂到真正的父节点，相对值保留，节点就落在 `60` 而不是 `300`。

**特征**：节点比预期整体偏左上 `240` 像素；同一脚本里有的节点中招、有的没中招（取决于引擎状态）——所以"刚才那个 frame 没问题"不能证明写法安全。

错误写法（先在"空中"组装子树，最后才挂到幻灯片）：

```js
// ✗ 外层卡片和内部文字都会中招
const box = figma.createFrame();
box.x = 160; box.y = 300;        // 此时还没有真正的父节点
const label = figma.createText();
label.x = 24; label.y = 24;
box.appendChild(label);
slide.appendChild(box);
```

正确写法（从幻灯片往下逐层"先挂后配"）：

```js
// ✓ 每一层：创建 → 挂载 → 配置 → 定位
const box = figma.createFrame();
slide.appendChild(box);
box.resize(480, 220);
box.fills = [{ type: "SOLID", color: { r: 0.98, g: 0.97, b: 0.94 } }];
box.cornerRadius = 20;
box.x = 160; box.y = 300;

await figma.loadFontAsync({ family: "Inter", style: "Bold" });
const label = figma.createText();
box.appendChild(label);
label.fontName = { family: "Inter", style: "Bold" };
label.characters = "+38%";
label.fontSize = 88;
label.x = 24; label.y = 24;
return { createdNodeIds: [box.id, label.id] };
```

## 2. 偏移问题的诊断

看到节点比设定值恰好差 `(−240, −240)` 时：

- **不要**在坐标上加 240 去"补偿"——补偿掩盖了结构问题，下次在稍有不同的状态下会再次触发，结果更糟。
- 正确处理：
  1. 构建后读回每个节点的 `x`/`y`，找出与写入值相差 −240 的节点；
  2. 把对应代码改为"先挂载后定位"（用下面的辅助函数）；
  3. 重新构建后再次读回，确认与写入值一致。

可以在构建脚本末尾附带一个漂移检查：

```js
// planned: 构建时记录的 [节点, 期望x, 期望y]
const planned = [[box, 160, 300], [label, 24, 24]];
const drift = [];
for (const [n, ex, ey] of planned) {
  const dx = Math.round(n.x - ex), dy = Math.round(n.y - ey);
  if (dx || dy) drift.push({ id: n.id, name: n.name, dx, dy });
}
return { drift }; // 非空说明某处违反了"先挂载后定位"
```

## 3. 辅助函数与代码前导模板

把"先挂载后定位"封装进辅助函数，让顺序不可能写错。新建 deck 时，在规划阶段定稿这段前导，之后**每个构建脚本原样粘贴**，只替换色板与字体为本 deck 的值。

```js
// ===== 前导：色板（按本 deck 替换）=====
const PAL = {
  ink:    { r: 0.09, g: 0.10, b: 0.13 },
  paper:  { r: 0.97, g: 0.96, b: 0.93 },
  panel:  { r: 0.16, g: 0.17, b: 0.22 },
  quiet:  { r: 0.55, g: 0.57, b: 0.62 },
  signal: { r: 0.95, g: 0.42, b: 0.20 },
};
// ===== 前导：字体（一次性并发加载）=====
const FONTS = [
  { family: "Inter", style: "Bold" },
  { family: "Inter", style: "Medium" },
  { family: "Inter", style: "Regular" },
];
await Promise.all(FONTS.map(f => figma.loadFontAsync(f)));

// ===== 前导：辅助函数（先挂载，再配置，最后定位）=====
function solid(color, opacity = 1) {
  return [{ type: "SOLID", color, opacity }];
}
function put(parent, node, x, y) {
  parent.appendChild(node);   // 1. 先挂载
  node.x = x; node.y = y;     // 2. 再定位（调用方应在此之前不设坐标）
  return node;
}
function box(parent, { x, y, w, h, color, radius = 0, name }) {
  const f = figma.createFrame();
  parent.appendChild(f);
  if (name) f.name = name;
  f.resize(w, h);
  f.fills = color ? solid(color) : [];
  f.cornerRadius = radius;
  f.x = x; f.y = y;
  return f;
}
function shape(parent, kind, { x, y, w, h, color, name }) {
  const s = kind === "ellipse" ? figma.createEllipse() : figma.createRectangle();
  parent.appendChild(s);
  if (name) s.name = name;
  s.resize(w, h);
  s.fills = solid(color);
  s.x = x; s.y = y;
  return s;
}
function label(parent, { text, x, y, size, color, family = "Inter", style = "Regular", width, align, lineHeight, name }) {
  const t = figma.createText();
  parent.appendChild(t);
  if (name) t.name = name;
  t.fontName = { family, style };
  t.fontSize = size;
  t.characters = text;
  t.fills = solid(color);
  if (lineHeight) t.lineHeight = { unit: "PERCENT", value: lineHeight };
  if (align) t.textAlignHorizontal = align;
  if (width) { t.textAutoResize = "HEIGHT"; t.resize(width, t.height); }
  t.x = x; t.y = y;
  return t;
}
const made = [];
const track = n => { made.push(n.id); return n; };
// ===== 前导结束 =====
```

使用示例（一张指标页）：

```js
const s = track(figma.createSlide());
s.name = "03 关键指标";
s.fills = solid(PAL.ink);
track(shape(s, "ellipse", { x: 1320, y: -260, w: 900, h: 900, color: PAL.signal, name: "母题-大圆" }));
track(label(s, { text: "+38%", x: 140, y: 300, size: 280, color: PAL.paper, style: "Bold", name: "主指标" }));
track(label(s, { text: "季度留存率提升", x: 150, y: 660, size: 44, color: PAL.paper, style: "Medium", width: 900 }));
return { createdNodeIds: made, slideId: s.id };
```

## 4. 字体加载：主题字体与现有文本

通用配方与 Design 文件相同：**加载字体 → `await` → 修改 → 返回 ID**。Slides 特别注意两点：

1. **Inter 常被预加载，但主题字体不会**。deck 常把主题字体换成 `Roboto Mono`、衬线字体或品牌字体，每一个要修改的 (family, style) 都必须显式 `loadFontAsync`。
2. **改已有文本时，加载节点"当前"使用的字体**，不要假设是 Inter。主题 token 可能把意想不到的字体推到节点上；文本内若混用多种字体，`fontName` 会是 `figma.mixed`。

```js
const node = await figma.getNodeByIdAsync("TEXT_ID");
const segs = node.getStyledTextSegments(["fontName"]);
const uniq = new Map(segs.map(s => [`${s.fontName.family}__${s.fontName.style}`, s.fontName]));
await Promise.all([...uniq.values()].map(f => figma.loadFontAsync(f)));
node.characters = "更新后的标题";
return { mutatedNodeIds: [node.id] };
```

样式名要精确：Inter 是 `"Semi Bold"`（带空格），不是 `"SemiBold"`。拿不准时先用 `figma.listAvailableFontsAsync()` 查询。

## 5. 独立的异步调用要批量 `await`

逐个 `await` 会产生多次往返。字体加载、按 ID 取幻灯片、导入库变量/样式等互不依赖的调用，用 `Promise.all` 一次完成，然后再顺序修改。

```js
const ids = ["1:10", "1:24", "1:38"];
const slides = await Promise.all(ids.map(id => figma.getNodeByIdAsync(id)));
for (const s of slides) {
  if (s && s.type === "SLIDE") s.isSkippedSlide = false;
}
return { mutatedNodeIds: slides.filter(Boolean).map(s => s.id) };
```

例外：`figma.setCurrentPageAsync` 这类切换页面上下文的调用必须顺序执行。

## 6. 用索引查询代替全树扫描，并缩小遍历范围

- 找文本用 `slide.findAllWithCriteria({ types: ["TEXT"] })`，找交互元素用 `{ types: ["INTERACTIVE_SLIDE_ELEMENT"] }`，不要用 `findAll(n => n.type === ...)`。
- 已知 ID 时直接 `await figma.getNodeByIdAsync(id)`，不要重新扫描树。
- **从最小的已知祖先开始遍历**：已知目标幻灯片时在该页内查找，而不是 `figma.currentPage.findAllWithCriteria(...)`（那会遍历整个 deck 的每一页）。

## 7. `SLIDE_GRID` / `SLIDE_ROW` 是不透明节点

| 节点类型 | 能力 | 有填充？ | 有子节点？ | 有布局属性？ |
|---|---|---|---|---|
| `SLIDE_GRID` | 不透明节点 | 否 | 是（各行） | 否 |
| `SLIDE_ROW` | 不透明节点 + 子节点 | 否 | 是（各页） | 否 |
| `SLIDE` | 完整 frame 能力（`BaseFrameMixin`） | 是 | 是（页内容） | 是 |

- 在网格或行上读写 `fills`、`effects`、布局属性会抛 `no such property ...`。背景色要设在 `SLIDE` 上。
- 唯一可写的例外是 `SLIDE_ROW.name`（分节名）。
- `getSlideGrid()` 返回的内层数组不是 `SLIDE_ROW` 节点，给它设属性静默无效。

```js
const gridNode = figma.currentPage.children.find(n => n.type === "SLIDE_GRID");
const firstSlide = gridNode.children[0]?.children[0];
if (!firstSlide) return { error: "deck 为空" };
firstSlide.fills = [{ type: "SOLID", color: { r: 0.08, g: 0.09, b: 0.14 } }];
return { mutatedNodeIds: [firstSlide.id] };
```

## 8. 其他会直接抛错或静默失败的 API

- `figma.createPage()`：Slides 中抛 `TypeError`（仅 Design 文件可用）。
- `SlideGridNode.clone()`：运行时抛错，网格本身不能复制。
- `getSlideTransition()` / `setSlideTransition()`：类型定义里有，运行时抛 "not implemented"，不要用；页面过渡需让用户在编辑器中设置。
- `figma.createTable()`、`figma.createGif()`：在 Slides 模式下被 Plugin API 屏蔽；表格与媒体请用户在编辑器 UI 中添加（或用形状+文字模拟简单表格）。
- `figma.createImage()` / `createImageAsync()`：不作为 Slides 的图片上传入口，放图片只用 `upload_assets`。
- `console.log()` 的输出不会返回；需要的数据一律 `return`。
- 直接子节点不能用 `FILL` 尺寸：幻灯片本身不是自动布局容器，给顶层容器显式宽度；只有挂进自动布局容器后的子节点才能设 `FILL`。

## 9. 没有 `get_metadata` 时如何校验

`get_metadata` 不支持 Slides。结构校验用只读 `use_figma`，视觉校验用 `get_screenshot` 或脚本内 `await slide.screenshot()`。

单页检查（列出子节点并找包围盒重叠）：

```js
const slide = await figma.getNodeByIdAsync("SLIDE_ID");
const items = slide.children.map(n => ({
  id: n.id, name: n.name, type: n.type,
  x: Math.round(n.x), y: Math.round(n.y), w: Math.round(n.width), h: Math.round(n.height),
  text: n.type === "TEXT" ? n.characters.slice(0, 40) : undefined,
}));
const hits = [];
items.forEach((a, i) => items.slice(i + 1).forEach(b => {
  const sepX = a.x + a.w <= b.x || b.x + b.w <= a.x;
  const sepY = a.y + a.h <= b.y || b.y + b.h <= a.y;
  if (!sepX && !sepY) hits.push([a.name, b.name]);
}));
return { items, overlaps: hits };
```

注意：有意为之的叠放（背景色块、出血装饰圆压在文字下）也会被报为重叠——读结果时结合规划判断，只处理非预期的重叠。

## 10. 批量校验脚本与校验节奏

每批构建后跑一次，约数秒完成，检查三类最常见问题：兄弟节点重叠、文字超出所在容器、元素整体越出画布。

```js
const SLIDE_IDS = ["SLIDE_ID_A", "SLIDE_ID_B"]; // 本批新建/修改的幻灯片
const TOL = 4;            // 重叠容差（像素）
const W = 1920, H = 1080; // 画布尺寸；若 deck 尺寸不同，改为读取 slide.width/height

const report = [];
const pages = await Promise.all(SLIDE_IDS.map(id => figma.getNodeByIdAsync(id)));
for (const pg of pages) {
  if (!pg) { report.push({ slide: null, kind: "missing" }); continue; }
  const kids = pg.children;
  // 1) 兄弟重叠
  for (let i = 0; i < kids.length; i++) {
    for (let j = i + 1; j < kids.length; j++) {
      const a = kids[i], b = kids[j];
      const ix = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const iy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (ix >= TOL && iy >= TOL) report.push({ slide: pg.id, kind: "overlap", a: a.name, b: b.name });
    }
  }
  // 2) 文字超出所在容器
  for (const k of kids) {
    if (!("findAllWithCriteria" in k) || k.type === "TEXT") continue;
    const box = k.absoluteBoundingBox;
    for (const t of k.findAllWithCriteria({ types: ["TEXT"] })) {
      const tb = t.absoluteBoundingBox;
      if (!box || !tb) continue;
      if (tb.x + tb.width > box.x + box.width + 1 || tb.y + tb.height > box.y + box.height + 1) {
        report.push({ slide: pg.id, kind: "textOverflow", text: t.name, container: k.name });
      }
    }
  }
  // 3) 整体越界
  for (const k of kids) {
    const gone = k.x + k.width < -TOL || k.y + k.height < -TOL || k.x > W + TOL || k.y > H + TOL;
    if (gone) report.push({ slide: pg.id, kind: "offCanvas", node: k.name });
  }
}
return { clean: report.length === 0, report };
```

**校验节奏**：

- 每批之后跑上面的脚本；`clean: true` 直接进入下一批，不截图、不重新规划。
- `clean: false`：截图相关页，修正后再继续。
- 无论是否 clean，在**第一批之后**（确认视觉系统）和**最后一批之后**（整体质量）各截 1–2 张代表页。
- 注意：刻意出血的装饰元素只会部分越出画布，不会被判为"整体越界"；但若装饰与正文重叠被报出，需确认是有意为之。
