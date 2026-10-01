---
name: web-app-scaffold
displayName: Web 应用脚手架
description: 当用户要从零新建一个前端/Web 应用项目（如 Vite + React/Vue/Svelte、TypeScript），并需要跑通开发服务器与生产构建时使用
origin: installed
requires:
  bins:
    - npm
---

## 适用场景

用户说"帮我建一个 React 项目"、"起一个前端脚手架"、"做个小工具网页"。已有项目的功能开发不适用本技能。

## 步骤（写明每步用哪个工具）

1. 明确需求：用 `ask_user` 确认框架（默认 React + TypeScript）、包管理器（默认 npm，用户项目已有约定时跟随）、项目目录名、是否需要路由 / 样式方案（CSS Modules、Tailwind）/ 测试。
2. 检查环境：用 `shell_run` 执行 `node -v` 与 `npm -v`，Node 版本低于 18 时提醒用户升级。用 `file_glob` 确认目标目录不存在或为空，避免覆盖。
3. 创建项目（非交互方式）：
   - React：`npm create vite@latest <目录> -- --template react-ts`
   - Vue：`--template vue-ts`；Svelte：`--template svelte-ts`；原生：`--template vanilla-ts`
   - 若命令仍出现交互提示，把选项告诉用户，由用户在终端完成。
4. 安装依赖：`cd <目录> && npm install`。按需追加（先确认）：路由 `npm install react-router-dom`；Tailwind 按其官方文档当前版本的 Vite 集成方式配置（用 `web_fetch` 查阅文档，不凭记忆写过时配置）。
5. 基础整理（`file_edit` / `file_write`）：
   - 替换模板示例页面为用户需求的首页骨架，设置 `index.html` 的 `<title>` 与 `lang`。
   - 建立目录约定：`src/components/`、`src/pages/`、`src/lib/`。
   - 如需环境变量，创建 `.env.example`（只含变量名），确认 `.gitignore` 包含 `.env*`（保留 `.env.example`）。
6. 跑通开发：用 `shell_run` 后台运行 `npm run dev`，用 `web_fetch` 访问 `http://localhost:5173` 确认返回；可用 `browser_automation` 打开并截图，用 `view_image` 检查页面正常渲染。验证后停止后台进程。
7. 跑通构建：`npm run build`，确认生成 `dist/` 且无 TypeScript 错误；再用 `npm run preview` 快速检查产物。
8. 可选：初始化 git（`git init`），写简短 README（启动、构建命令）。是否提交由用户决定。
9. 向用户汇报：目录结构、常用命令（`npm run dev` / `npm run build`）、后续可选步骤（如部署可使用网站部署插件）。

## 注意事项 / 安全

- 不覆盖已有目录；目标目录非空时先询问。
- 安装第三方依赖前说明用途并征得同意，避免引入不必要的包。
- 后台启动的开发服务器在结束前停止，避免占用端口。
- 不在前端代码中放置任何服务端密钥（前端环境变量会被打包进产物）。

## 如何确认完成

`npm run dev` 能在浏览器中正常显示首页，`npm run build` 成功且无报错，用户知道如何启动和构建。
