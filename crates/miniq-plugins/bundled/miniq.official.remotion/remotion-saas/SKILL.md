---
name: remotion-saas
description: Build an app with Remotion
version: 1
origin: bundled
---

> 移植说明：本技能移植自 remotion/remotion-saas（MIT），已适配 miniQ。文中的工具名按 miniQ 原生工具理解：`shell_run` 执行命令、`browser_automation` 操作内置浏览器、`agent_run` 派发子代理、`ask_user` 询问用户、`mcp__<server>__<tool>` 调用本插件连接器、`skill_read` 读取其他技能及附属文件（相对路径以本技能目录为准）。原文针对 Codex 应用 Run 按钮 / `.codex/environments` 的步骤在 miniQ 中不适用，可跳过。

One can build apps with Remotion.
It is possible to have a simple form and hook it up to a render, or have a complex video editor.

## Choosing a template or a framework

We have several templates for SaaS which can be cloned or used as a reference.
See [Choosing a framework](framework.md) for help choosing a template or framework.

## The `<Player>`

This component allows embedding a Remotion preview in a React app. See [Player](player.md) for more information about the Player.

## Rendering

There are client-side and server-side rendering options available. See [Rendering](rendering.md) for advice on how to choose, and about the Lambda, Vercel, Node.js and Cloudflare options.

## With Vue

See https://www.remotion.dev/docs/vue.md for how to use Remotion with Vue.

## Angular

See https://www.remotion.dev/docs/angular.md for how to use Remotion with Angular.

## Svelte

See https://www.remotion.dev/docs/svelte.md for how to use Remotion with Svelte.
