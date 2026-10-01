# 产品字体：先识别，后校验

## 为什么重要
Inter 在 Figma 中总是可用、样式名规整，脚本很容易“顺手”用它；但产品若用 SF Pro、思源黑体或自定义字体，画面会“能运行但不对”，且肉眼不易察觉。**除非源码确实没有指定字体，否则不要用 Inter。**

`figma.listAvailableFontsAsync()` 只能回答“文件里能不能用某字体”，不能回答“产品用的是哪个字体”。先从源码确定字体族，再用它匹配可用样式。

## 在哪里找（按优先级）
1. **样式代码**：CSS/SCSS 中的 `font-family`、`--font-*` 自定义属性；`tailwind.config.*` 的 `theme.fontFamily`（以及 `fontSans` 等被 `body` 使用的那一项）；styled-components/Emotion 主题；全局样式表；`@font-face` 与 `next/font` 引入。
2. **组件与主题**：文字组件上的 `fontFamily`、`theme.typography.fontFamily`、设计令牌模块。
3. **平台默认**：iOS/SwiftUI 未指定时为 SF Pro（系统字体），Android/Compose 默认 Roboto，Flutter 看 `ThemeData.fontFamily`。
4. **令牌 JSON** 中的 `fontFamily`：经常不存在，没有也不代表“未指定字体”。
中文产品还需确认中文字体（如 PingFang SC、思源黑体 / Noto Sans SC），以及字体栈中中英文分别由谁渲染。

可用命令：
```bash
grep -rnE "font-family|fontFamily|--font-" --include=*.{css,scss,ts,tsx,js,json} src | head -50
```

## 解析成 Figma 可用的字体名
```js
const fonts = await figma.listAvailableFontsAsync();
const want = /SF Pro/i;                       // 从源码得到的字体族
const hits = fonts.filter(f => want.test(f.fontName.family))
                  .map(f => `${f.fontName.family} / ${f.fontName.style}`);
return hits.slice(0, 80);
```
- 真实名称往往不整洁：可能是 `SF Pro` + `Semibold`、`SF Pro Text` + `Regular`、甚至 `Compressed Medium` 之类的变体样式。选择**与产品字重最接近的常规宽度样式**，不要因为名字难匹配就换成 Inter。
- 字重对照：400 Regular、500 Medium、600 Semi Bold/Semibold、700 Bold。
- 字体在文件中不可用（未安装/非共享字体）：`ask_user` 告知，选项为“安装字体后继续”或“临时用某替代字体并在交付中标注”。

## 构建后校验（必做）
```js
const wrapper = await figma.getNodeByIdAsync("<WRAPPER_ID>");
const EXPECTED = new Set(["SF Pro", "SF Mono"]);   // 产品实际使用的全部字体族
const inInstance = n => { for (let p = n.parent; p; p = p.parent) if (p.type === "INSTANCE") return true; return false; };
const fix = [], dsGap = [];
for (const t of wrapper.findAll(n => n.type === "TEXT")) {
  for (const seg of t.getStyledTextSegments(["fontName", "textStyleId"])) {
    if (EXPECTED.has(seg.fontName.family)) continue;
    const governed = seg.textStyleId !== "" || inInstance(t);
    (governed ? dsGap : fix).push({ id: t.id, name: t.name, family: seg.fontName.family, style: seg.fontName.style });
  }
}
return { expected: [...EXPECTED], fix, dsGap };
```
- `fix` 非空：这些是你自建的文字，判定校验失败；按 `figma-use` 中的改字流程先 `loadFontAsync` 正确字体再设 `fontName`。
- `dsGap`：处于设计系统实例内或挂着库文字样式，由设计系统决定（例如代码块用等宽字体），**不要强行覆盖**，在交付中列为“设计系统差异”。
- 有源参考（运行中的网页、设计稿、截取结果）时，再并排对比截图：字形、字重、字号、行高。同一字体族内选错样式（例如压缩体）只有视觉对比才能发现。
