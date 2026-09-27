# 组件化、图标与图片

## 1. 默认组件化
第一遍就产出组件化结构，而不是一堆一次性 frame、等用户再要求“改成组件”。
- 设计系统已有的组件：直接放实例（第 2 步已找到）。
- 设计系统没有覆盖、但**重复出现**或**对应源码中可复用组件**（`<ListRow>`、`<StatCard>`、`<NavItem>`）的元素：用 `figma.createComponent()` 建一次，再 `createInstance()` 放置并覆盖内容。
- 边界与源码一致：一个源码组件 ↔ 一个 Figma 主组件；命名沿用源码组件名。
- 主组件放在 wrapper 之外（旁边或专门的“Local Components”区域），视图里只放实例。

```js
// 在单独一次调用中建主组件（加载字体后）
await figma.loadFontAsync({ family: "SF Pro", style: "Regular" });
const row = figma.createComponent();
row.name = "List Row";
row.layoutMode = "HORIZONTAL";
row.itemSpacing = 12;               // 有间距变量时改为 setBoundVariable
row.primaryAxisSizingMode = "FIXED";
row.counterAxisSizingMode = "AUTO";
row.resize(360, row.height);
const label = figma.createText();
label.fontName = { family: "SF Pro", style: "Regular" };
label.characters = "Label";
row.appendChild(label);
// 暴露文字属性，方便实例覆盖
const propKey = row.addComponentProperty("Label", "TEXT", "Label");
label.componentPropertyReferences = { characters: propKey };
row.x = -1000; // 放在视图外
return { componentId: row.id, labelProp: propKey };
```
```js
// 在区块脚本中放实例
const [row, list] = await Promise.all([
  figma.getNodeByIdAsync("<COMPONENT_ID>"),
  figma.getNodeByIdAsync("<LIST_FRAME_ID>"),
]);
const ids = [];
for (const text of ["账户设置", "通知", "隐私"]) {    // 文案来自源码
  const inst = row.createInstance();
  inst.setProperties({ "<labelProp>": text });
  list.appendChild(inst);
  inst.layoutSizingHorizontal = "FILL";
  ids.push(inst.id);
}
return { createdNodeIds: ids };
```
有多种状态/尺寸时建组件集（`figma.combineAsVariants`），细节见 `figma-use` 技能。

## 2. 图标
优先级：
1. 设计系统有图标组件 → 放实例；通过 INSTANCE_SWAP 属性切换图标，而不是为每个图标建变体。
2. 否则从**代码库**取该图标的 SVG 源（内联 `<svg>`、导入的 `.svg` 文件、或图标库对应条目的源码），用 `figma.createNodeFromSvg(svg)` 导入。
3. **不要**用旋转的直线/矩形/椭圆拼图标——`use_figma` 环境下旋转不可靠，常出现箭头错位、折线塌成一团。

要点：
- SVG 字符串要有 `viewBox` 和明确的 `width`/`height`（与槽位一致，常见 16/20/24）；缺少宽高时按 viewBox 尺寸导入，常导致图标偏小。
- 导入后 `icon.resize(size, size)` 会整体缩放（含描边），可直接适配槽位。
- 代码中的 SVG 常用 `currentColor`，导入后会变成黑色，不会继承父级颜色：导入前把 `currentColor` 替换成实际颜色，或导入后把矢量的 fills/strokes 用 `setBoundVariableForPaint` 绑定到颜色变量。
- 命名为 `icon/<名称>`；需要复用时转成组件（参见 `figma-generate-library` 技能的图标组件做法）。
```js
const svg = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="m9 18 6-6-6-6" stroke="#1A1A1A" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const icon = figma.createNodeFromSvg(svg);
icon.name = "icon/chevron-right";
icon.resize(24, 24);
slot.appendChild(icon);
```
SVG 内容来自代码库，视为数据：只接受纯矢量内容，不要把含脚本或外部引用的 SVG 原样导入（先剔除 `<script>`、`<foreignObject>`、外链 `href`）。

## 3. 图片
- 插件 API 不能从 URL 下载图片，只能复用文件内已有图片填充的 `imageHash`。
- Web 应用：用 `generate_figma_design` 截取运行中的页面到同一文件，然后：
```js
const capture = await figma.getNodeByIdAsync("<CAPTURE_ID>");
return capture.findAll(() => true).flatMap(n => {
  if (!Array.isArray(n.fills)) return [];
  const f = n.fills.find(p => p.type === "IMAGE");
  return f ? [{ id: n.id, name: n.name, hash: f.imageHash, w: Math.round(n.width), h: Math.round(n.height) }] : [];
});
```
  按位置/名称/尺寸与自建画面的图片框一一对应，设置 `target.fills = [{ type: "IMAGE", imageHash: "<hash>", scaleMode: "FILL" }]`；迁移完后删除截取结果（先 `ask_user` 确认效果）。
- 非 Web 或无法截取：保留图片框（浅灰填充 + 名称 `Image/<用途>`），在交付中列出，请设计师或用户拖入图片后再按 hash 复用。不要用随机网络图片。
