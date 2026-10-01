# 可访问性与布局规范

- 使用语义化 HTML 和原生控件（`button`、`input`、`select`、`textarea`），每个控件都要有可见标签。
- 保持原生的 Tab 顺序，**不要**添加 `tabindex`，也不要去掉浏览器的焦点样式。
- 动态结果（选中项、计算结果、模拟状态）所在的容器加 `aria-live="polite"`。
- SVG 加 `role="img"` 和 `aria-label`，或者在内部写 `<title>`。复杂图表可以另外附一个 `.sr-only` 数据表。
- 触屏设备上，可点击目标约 44×44px，且互不重叠。`viz-base.css` 已在 `pointer: coarse` 下放大按钮。
- 重要内容和操作不能只依赖悬停。
- 颜色不能是唯一的编码方式：同时配合形状、线型或直接标签。
- 文字与它实际所在背景之间的对比度要够。次要文字只用于非关键信息。
- 在所有宽度下（最窄 360px），文字、控件和卡片都不能溢出或被遮挡。宽表格外层包 `.table-responsive`。
- 尊重 `prefers-reduced-motion`：样式里已全局关闭动画。JS 动画也要检查这个设置。
- 页面语言设为 `lang="zh-CN"`，字体栈要包含 PingFang SC 和 Microsoft YaHei。
