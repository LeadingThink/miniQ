# 在现有代码库中修改

当任务是修改一个已有的本地网站或应用（而不是新建原型）时，遵循本流程。

## 1. 先看再改

1. 用 `glob` 了解项目结构：`package.json`、框架配置（`vite.config.*`、`next.config.*`、`nuxt.config.*`、`tailwind.config.*`）、`src/`、`app/`、`components/`。
2. 用 `file_read` 读项目根的 `AGENTS.md`、`README.md`、`CONTRIBUTING.md`、`docs/design*` 等设计约定；有约定就遵守。
3. 能跑起来就先跑起来（`shell_run` 执行其 `dev` 脚本，后台运行），用 `browser_automation` 截一张改动前的图，作为对比基线。

## 2. 找设计系统与 token（必须做）

用 `grep` / `glob` 搜索以下线索，找到就复用，不要另起一套：

| 类型 | 常见位置 / 关键词 |
| --- | --- |
| 颜色、间距、圆角、阴影 token | `tokens/`、`theme.*`、`design-tokens.json`、`:root {` 中的 `--color-*` `--space-*`、`tailwind.config` 的 `theme.extend` |
| 字体 | `@font-face`、`fontFamily`、`next/font`、Google Fonts 链接 |
| 组件库 | `components/ui/`、`@/components`、`shadcn`、`antd`、`@mui`、`element-plus`、`vant`、Storybook（`.storybook/`、`*.stories.*`） |
| 图标库 | `lucide-react`、`@heroicons`、`@tabler/icons`、`remixicon`、`@iconify`、`phosphor` |
| 布局模式 | 现有页面的栅格、容器宽度、导航结构 |

把找到的结果（token 文件路径、组件库名、图标库名）记在心里；若项目缺少记录，可在收尾时建议把关键约定写进 `AGENTS.md` 或设计说明（需用户同意再写）。

## 3. 改动原则

- 优先复用已有组件与布局；新组件的样式必须引用已有 token，而不是写死色值。
- 不重构与本次任务无关的结构；用户没要求重设计时不改变整体视觉语言。
- 使用贴近真实的模拟数据（真实感的人名、金额、日期），不用 “Lorem ipsum”、“测试1”。
- 不添加为了“填满界面”的虚构功能。
- 不在界面里写长篇解释文字。
- 不用文字、标点、emoji、CSS 形状、占位框或手写 SVG 代替图标与图片资产。
- 用 `file_edit` 做精确修改，避免整文件覆盖；覆盖用户已有文件前先 `ask_user`。

## 4. 验证

- 改完后重新运行、截同一视口同一状态的图，与基线对比，确认没有破坏其他区域。
- 项目有 lint/test/typecheck 脚本时跑一遍，失败要修或如实报告。
- 构建类改动同样要过 `product-design-qa`。
