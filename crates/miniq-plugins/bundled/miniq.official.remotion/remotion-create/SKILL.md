---
name: remotion-create
description: Create a new Remotion video
version: 1
origin: bundled
---

> 移植说明：本技能移植自 remotion/remotion-create（MIT），已适配 miniQ。文中的工具名按 miniQ 原生工具理解：`shell_run` 执行命令、`browser_automation` 操作内置浏览器、`agent_run` 派发子代理、`ask_user` 询问用户、`mcp__<server>__<tool>` 调用本插件连接器、`skill_read` 读取其他技能及附属文件（相对路径以本技能目录为准）。原文针对 Codex 应用 Run 按钮 / `.codex/environments` 的步骤在 miniQ 中不适用，可跳过。

These are instructions for making a new Remotion project and composition.
If this is not the next task, see [Remotion Best Practices]（用 skill_read 读取技能 `remotion-best-practices`）

## Scaffold a project

If a project already exists, skip this.
Ensure Node.js and Git is installed, and the current folder is appropriate for starting a new project.

Scaffold one using:

```bash
npx create-video@latest --yes --blank --no-tailwind my-video
cd my-video
npm i
```

Replace `my-video` with a suitable project name.

## Designing a video

Keep the scaffold and add React Markup.
Follow [Remotion React Markup Best Practices]（用 skill_read 读取技能 `remotion-markup`） and [Video Layout Rules](video-layout.md) for video-first layout and text sizing guidance.

## Is this a multi-scene video?

If this is a video with multiple subsequence videos, follow guidance at [Multi-scene videos]（用 skill_read 读取技能 `remotion-markup`）.

## Interactivity Best Practices

By structuring the React Markup following [Remotion Interactivity Best Practices]（用 skill_read 读取技能 `remotion-interactivity`）, you allow the user to make edits in the Studio which write back to code.

## TailwindCSS

If Tailwind is requested, see [tailwind.md](tailwind.md) for using TailwindCSS in Remotion.

## Open the preview

After creating or updating the video, start the preview server by default:

```bash
npx remotion studio --no-open
```

This will start a long-running process and print the server URL for the preview.
If the server is already started, it will print the URL.
Open the exact URL in the miniQ built-in browser (browser_automation). If no browser tool is available yet, use `tool_search` for the in-app browser control tool, then navigate to the local URL.
You can visit a specific composition by navigating to `/[composition-id]`, for example `http://localhost:3000/MapAnimation`.

## Render the video

Only render if the user explicitly asks for it.

```
npx remotion render
```

For more options, see [Rendering]（用 skill_read 读取技能 `remotion-render`）.

## Follow-up

The video creation process has finished.
For follow-up prompts, use [Remotion Best Practices]（用 skill_read 读取技能 `remotion-best-practices`）
