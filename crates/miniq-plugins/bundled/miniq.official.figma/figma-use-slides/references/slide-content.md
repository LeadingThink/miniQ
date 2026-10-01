# 页内内容与文案写法

> 属于 `figma-use-slides` 技能。`SLIDE` 节点具备完整 frame 能力（`BaseFrameMixin`），页内可以放文字、形状、图片、自动布局容器、组件与实例，写法与 Design 文件基本一致——但**始终遵守"先挂载后定位"**（见 `slide-gotchas.md`）。本文后半部分讲标题、要点、讲者备注怎么写。

## 目录

A. 构建页内内容
1. 画布与定位
2. 文字
3. 原生项目符号 / 编号列表
4. 形状与背景
5. 图片（只能用 `upload_assets`）
6. 自动布局容器
7. 组件与实例
8. 修改已有内容

B. 文案写法
9. 标题
10. 要点与正文
11. 数字、图表与引用
12. 讲者备注

---

## A. 构建页内内容

### 1. 画布与定位

- 画布尺寸通常 1920×1080，以 `slide.width`/`slide.height` 为准。
- 用相对幻灯片左上角的绝对 `x`/`y` 定位，或放进自动布局容器让其自动排列。
- 顺序永远是：**创建 → `appendChild` 到最终父节点 → 配置尺寸/样式 → 设置 `x`/`y`**，每一层嵌套都一样。

### 2. 文字

配方：加载字体 → `await` → 修改 → 返回 ID。Inter 通常预加载，其他字体不加载会报 `Cannot write to node with unloaded font "<family> <style>"`。样式名必须精确（Inter 是 `"Semi Bold"`），不确定时 `figma.listAvailableFontsAsync()` 查询。

```js
const slide = await figma.getNodeByIdAsync("SLIDE_ID");
const F = { family: "Noto Serif SC", style: "Bold" };
await figma.loadFontAsync(F);

const heading = figma.createText();
slide.appendChild(heading);
heading.fontName = F;
heading.fontSize = 96;
heading.characters = "把复杂留给系统";
heading.textAutoResize = "HEIGHT";
heading.resize(1200, heading.height);   // 固定宽度、高度随内容
heading.x = 140;
heading.y = 180;
return { createdNodeIds: [heading.id] };
```

- 长文本请固定宽度并设 `textAutoResize = "HEIGHT"`，避免单行无限延长越出画布。
- 中文 deck 选择含中文字形的字体（如思源/Noto 系列），否则会回退显示或加载失败。

### 3. 原生项目符号 / 编号列表

用**一个 TextNode**：各项以 `\n` 分隔，再调用 `setRangeListOptions(start, end, { type })`，`type` 取 `"UNORDERED"`（圆点）、`"ORDERED"`（编号）或 `"NONE"`（移除列表格式）。这样换行时自带悬挂缩进，且整段是可编辑的单一文本。

```js
const slide = await figma.getNodeByIdAsync("SLIDE_ID");
await Promise.all([
  figma.loadFontAsync({ family: "Inter", style: "Bold" }),
  figma.loadFontAsync({ family: "Inter", style: "Regular" }),
]);
const head = "本季度三件事";
const items = ["上线自助开户", "客服响应压到 2 小时内", "关停旧版计费系统"];

const t = figma.createText();
slide.appendChild(t);
t.fontName = { family: "Inter", style: "Regular" };
t.fontSize = 36;
t.characters = [head, ...items].join("\n");
t.lineHeight = { unit: "PERCENT", value: 150 };
t.setRangeFontName(0, head.length, { family: "Inter", style: "Bold" });
// 只把标题行之后的部分设为列表
t.setRangeListOptions(head.length + 1, t.characters.length, { type: "ORDERED" });
t.textAutoResize = "HEIGHT";
t.resize(900, t.height);
t.x = 140; t.y = 360;
return { createdNodeIds: [t.id] };
```

**不要**用"小圆点 ellipse + 文字"的横向自动布局来拼项目符号：文字换行时第二行会顶到圆点下方（没有悬挂缩进），还会产生一堆零散节点，难以编辑。

### 4. 形状与背景

```js
const slide = await figma.getNodeByIdAsync("SLIDE_ID");
// 背景直接设在幻灯片上（不是 SLIDE_ROW/GRID）
slide.fills = [{
  type: "GRADIENT_LINEAR",
  gradientTransform: [[1, 0, 0], [0, 1, 0]],
  gradientStops: [
    { position: 0, color: { r: 0.07, g: 0.08, b: 0.16, a: 1 } },
    { position: 1, color: { r: 0.18, g: 0.12, b: 0.32, a: 1 } },
  ],
}];
// 从右侧出血的色块
const band = figma.createRectangle();
slide.appendChild(band);
band.resize(720, 1080);
band.fills = [{ type: "SOLID", color: { r: 0.96, g: 0.78, b: 0.26 } }];
band.x = slide.width - 520;   // 部分越出画布，形成出血
band.y = 0;
return { mutatedNodeIds: [slide.id], createdNodeIds: [band.id] };
```

### 5. 图片（只能用 `upload_assets`）

- 往幻灯片放图片**唯一**支持的方式是 MCP 工具 `upload_assets`；不要在 `use_figma` 中用 `figma.createImage()` / `figma.createImageAsync()` 作为上传入口。
- 调用 `upload_assets` 时传 Slides 的 `fileKey`；工具返回一次性上传 URL，向其 POST 原始图片字节后图片会自动提交并放置。
- 传 `nodeId`（配合 `count: 1`）：作为已有节点（如先放好的矩形占位框）的图片填充——便于精确控制位置与裁切；省略 `nodeId`：作为新图层放到幻灯片上，之后再用 `use_figma` 调整位置尺寸。
- 具体请求/响应字段以 `tools/list` 返回的 schema 为准。

推荐流程：先用 `use_figma` 画好占位矩形并返回其 ID → `upload_assets` 以该 `nodeId` 填图 → 截图确认裁切。

### 6. 自动布局容器

幻灯片本身不是自动布局容器，**其直接子节点不能用 `FILL` 尺寸**，给顶层容器显式宽度；挂进自动布局容器之后的子节点才能设 `FILL`。

```js
const slide = await figma.getNodeByIdAsync("SLIDE_ID");
await figma.loadFontAsync({ family: "Inter", style: "Medium" });

const col = figma.createFrame();
slide.appendChild(col);
col.name = "要点栏";
col.layoutMode = "VERTICAL";
col.itemSpacing = 28;
col.paddingTop = col.paddingBottom = 48;
col.paddingLeft = col.paddingRight = 56;
col.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
col.cornerRadius = 32;
col.resize(640, 100);
col.layoutSizingVertical = "HUG";   // 高度随内容
col.x = 1140; col.y = 240;

for (const line of ["延迟 −42%", "成本 −18%", "可用性 99.97%"]) {
  const t = figma.createText();
  col.appendChild(t);                // 先挂进自动布局容器
  t.fontName = { family: "Inter", style: "Medium" };
  t.fontSize = 40;
  t.characters = line;
  t.layoutSizingHorizontal = "FILL"; // 挂载后才能 FILL
}
return { createdNodeIds: [col.id, ...col.children.map(c => c.id)] };
```

### 7. 组件与实例

Slides 模式下允许创建组件（`SYMBOL`）与实例，适合在多页重复使用的元素（页脚、页码徽标、标签）。

```js
const a = await figma.getNodeByIdAsync("SLIDE_ID_A");
const b = await figma.getNodeByIdAsync("SLIDE_ID_B");
const tag = figma.createComponent();
a.appendChild(tag);
tag.name = "页脚标签";
tag.resize(240, 48);
tag.cornerRadius = 24;
tag.fills = [{ type: "SOLID", color: { r: 0.95, g: 0.42, b: 0.2 } }];
tag.x = 140; tag.y = 980;

const inst = tag.createInstance();
b.appendChild(inst);
inst.x = 140; inst.y = 980;
return { createdNodeIds: [tag.id, inst.id] };
```

### 8. 修改已有内容

- 先盘点（`slide-structure.md` 第 2 节），拿到目标节点 ID 后用 `getNodeByIdAsync` 直接取，不要全树扫描。
- 改文字前加载该节点**当前**所有字体（`getStyledTextSegments(["fontName"])`）。
- 改版式时保留原节点（改位置/尺寸/样式），不要删了重建，以免丢失用户手动做过的细节。
- 返回 `mutatedNodeIds`。

---

## B. 文案写法

### 9. 标题

- 一页一个观点，标题就是这个观点本身：写结论（"新流程把开户时间缩短一半"）而非话题（"开户流程"）。
- 简短：中文尽量 ≤ 18 字，一到两行；超过两行说明观点没提炼好。
- 封面标题可以更有态度；章节过渡页可以只有一个短语。
- 全篇标题语气、句式、标点风格保持一致（都用陈述句，或都不带句号）。

### 10. 要点与正文

- **幻灯片不是文档**：几秒内能看懂才合格。需要仔细阅读才懂，就是内容太多。
- 要点通常 ≤ 3–5 条，每条一行、一个意思，以名词短语或动宾短语开头，避免完整长句。
- **编辑就是删减**：把源材料做成幻灯片时，决定删什么比决定留什么更重要。每删一条，剩下的更有力。
- **放不下就拆成两页**，而不是缩小字号或压缩行距。
- 列表、对比表、多栏布局最容易越塞越多：问的不是"还放得下吗"，而是"这一条值得削弱其他条的冲击力吗"。

### 11. 数字、图表与引用

- 关键数字单独成页或放到极大字号（见 `slide-design.md` 字号层级），旁边只配一句解释。
- 图表只保留支撑结论的数据系列，标出要观众看的那个点；表格和复杂图表在 Slides 中无法用 API 原生创建，可用形状+文字构建简化版，或请用户在编辑器中插入。
- 引言可以就是大号（斜体）文字加出处，不必套卡片容器。

### 12. 讲者备注

讲者备注只在演讲者视图中对讲者可见，是讲者的提词卡、提示单。

**何时写**

- 用户要求讲者备注、演讲要点、讲稿时：为每张有实质内容的页写（纯装饰页、章节过渡页没什么可说的可以留空）。
- 用户明确要"可以直接上台讲"的 deck：在备注能帮助把握节奏、过渡、页面上看不到的背景时添加。
- 以图表、图片、隐喻或设问为主的稀疏页：备注说明讲者该讲什么；需要时截图该页理解视觉内容，但不要默认给每页截图（消耗上下文）。
- **不要主动添加**：普通改稿、调版式、更新已有 deck 时，除非用户要求，否则不写备注——备注会改变演讲流程，可能让 deck 主人意外。

**好备注的特征**

- **补充而非复述**：页上写"营收增长 40%"，备注写为什么增长、观众应带走什么、通常会引出什么问题。
- **简短可扫读**：讲到一半低头要能立刻找到位置；用短要点，一条一个意思。
- **包含过渡语**：告诉讲者如何接到下一页，或回扣前面的数字。
- **携带页面放不下的上下文**：数据来源与口径、注意事项（"如财务负责人在场可跳过"）、时间提示（"到这里约 10 分钟"）、预判提问（"会问毛利——见附录第 14 页"）。
- **语气匹配场合**：融资路演精确、排练过；团队复盘随意灵活；主题演讲可以含舞台提示。

**避免**

- 整段讲稿：大段文字会诱导照念。用户明确要逐字稿才写，否则默认要点。
- 为观众优化排版：观众看不到备注。
- 与页面重复：自解释的页（如"谢谢"+联系方式）可以不写。

**格式**：`slide.speakerNotes` 接受 markdown 字符串。以列表为主，对讲者不可遗漏的关键词用粗体。支持：无序/有序列表、粗体、斜体、粗斜体、删除线；不支持（会原样显示）：标题、代码、链接、下划线。

```js
const notes = {
  "SLIDE_ID_1": ["- 开场先停 3 秒，让大数字自己说话", "- **强调：这是连续第三个季度增长**", "- 过渡：\u201c那增长从哪里来？\u201d"],
  "SLIDE_ID_2": ["1. 先讲渠道结构变化", "2. 再讲单客价值", "- 口径：内部看板，*未经审计*"],
};
const ids = Object.keys(notes);
const slides = await Promise.all(ids.map(id => figma.getNodeByIdAsync(id)));
slides.forEach((s, i) => { s.speakerNotes = notes[ids[i]].join("\n"); });
return { mutatedNodeIds: ids };
```
