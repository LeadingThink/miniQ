# UI 原型的设计微调（assets/viz-tweak.js）

做 UI 原型时（按钮、卡片、弹窗、页面），给出几个值得比较的设计变量，让用户自己拖动试。这比让用户用文字描述“再圆一点”高效得多。

## 用法
1. 片段中先把初始状态渲染出来，再绑定 Tweak：
   ```js
   const state = { radius: 12, accent: "#2563eb", compact: false, layout: "列表" };
   const mock = document.getElementById("order-card");
   function render() {
     mock.style.borderRadius = state.radius + "px";
     mock.style.setProperty("--accent", state.accent);
     mock.classList.toggle("compact", state.compact);
     mock.dataset.layout = state.layout;
   }
   render();
   if (window.Tweak) {           // 保持可选：没有助手时页面照常显示
     const t = new Tweak({ container: mock, title: "订单卡片", onChange: render });
     t.addSlider(state, "radius", { label: "圆角", min: 0, max: 32, unit: "px" });
     t.addColorPicker(state, "accent", { label: "强调色" });
     t.addToggle(state, "compact", { label: "紧凑" });
     t.addSelect(state, "layout", { label: "布局", options: ["列表", "网格"] });
   }
   ```
2. 生成页面：`viz.py wrap 片段.html -o 原型.html --tweak`，会把助手内联进页面。
3. 面板浮在右下角，提供“重置”和“复制参数”。复制参数会得到当前 state 的 JSON，用户把它发回来，你就能把选定的取值写进正式代码。

## API
- `addSlider(obj, key, {min, max, step=1, unit, label})`：数值。
- `addColorPicker(obj, key, {label})`：十六进制颜色。
- `addToggle(obj, key, {label})`：布尔值。
- `addSelect(obj, key, {options, label})`：字符串。选项可以是字符串，也可以是 `{label, value}`。
- `values()`：返回当前取值。`reset()`：恢复初始值。`destroy()`：移除面板。
- 每个可独立调整的元素用一个 Tweak 实例。`onChange` 只做确定性的本地渲染。

## 原型规则
- 原型内部使用产品自己的样式（`--accent` 等自定义变量）。**不要**混用可视化令牌（`--viz-*`），否则原型会跟着可视化主题变色。
- 有局部原型和整页原型两种：
  - 局部原型：组件、弹窗、手机屏幕，居中放在一个框里。
  - 整页原型：桌面窗口、应用外壳，按 1024px 以上的宽度绘制。
- 全局导航放在应用框架里，局部控件放在它所影响的区域旁边。
- 只提供 2–5 个真正影响决策的变量，不要把所有 CSS 属性都做成滑块。
