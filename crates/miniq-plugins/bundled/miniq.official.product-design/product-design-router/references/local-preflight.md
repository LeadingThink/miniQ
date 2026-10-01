# 本地原型预检

新建本地原型前做一次预检，确保项目自包含、能在本地预览、能被浏览器截图验证。

## 1. 运行预检脚本

```bash
python3 <插件目录>/product-design-user-context/scripts/preflight.py check --workspace <工作区绝对路径>
```

脚本会报告：user-context.md 是否存在与必填字段是否完整、已有原型目录、`node` / `npx` / `npm` / `python3` 是否可用、从 4173 起第一个空闲端口。输出末尾有 JSON 摘要，可据此决策。

## 2. 选择技术路线

| 情况 | 路线 |
| --- | --- |
| 单页/多屏演示、无依赖、需要最快出结果 | 静态 HTML：基于 `product-design-prototype/scripts/prototype-template.html`，放在 `design/prototype/` |
| 需要组件化、复杂状态、多路由，且 `node`/`npm` 可用 | Vite 项目：`npx -y create-vite@latest <目录> --template react-ts`（或 vue-ts），`npm install` 后开发 |
| 在现有项目里加页面 | 不新建项目，按 `existing-codebase.md` 在原项目里做 |
| `node` 不可用 | 静态 HTML 路线；不要因为安装慢就把已选的 Vite 路线降级为静态页，除非安装确实失败，并如实说明 |

移动端原型：内容区按 390×844 设计；不要画手机外壳、刘海、状态栏时钟、电量等设备装饰（除非用户要求演示外壳），这些不是产品内容。

## 3. 目录约定

- 新原型放在工作区内独立目录，如 `design/prototype/` 或 `<项目名>-prototype/`，不要散落到其他位置。
- 生成的图片放在原型目录的 `assets/` 下，文件名语义化（`hero-1440x720.png`、`avatar-lin.png`）。
- 截图与 QA 证据放在 `design/qa/`（或原型目录下 `qa/`），`design-qa.md` 放在原型项目根目录。
- 代码中使用相对路径引用资源，不要写死 `localhost` 或绝对路径。

## 4. 启动本地预览

- 静态目录：
  ```bash
  python3 <插件目录>/product-design-prototype/scripts/serve.py --dir <原型目录> --port 4173
  ```
  或直接 `python3 -m http.server 4173 --directory <原型目录>`。用 `shell_run` 后台运行（runInBackground）。
- Vite 项目：`npm run dev -- --port 4173 --strictPort`，同样后台运行。
- 端口被占用时换预检脚本给出的空闲端口。
- 启动成功 ≠ 验证完成。必须用 `browser_automation` 打开 `http://127.0.0.1:<端口>/`，截图、点主交互、检查控制台错误，并通过 `product-design-qa`。
- 交付时保持预览进程运行，把地址给用户。

## 5. 视口约定

| 场景 | 视口 |
| --- | --- |
| 手机 App | 390 × 844 |
| 平板 | 834 × 1194 |
| 桌面应用 / 后台 / SaaS | 1440 × 1024 |
| 营销落地页 | 1440 宽，可滚动（截图时截全页或分段） |
| 弹窗 / 组件 | 组件自然尺寸 |
| 有参考图 | 与参考图相同的宽高与比例 |
