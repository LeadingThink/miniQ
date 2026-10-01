---
name: remotion-multimedia
displayName: Remotion 多媒体
description: Interacting with Mediabunny
version: 1
origin: bundled
---

> 移植说明：本技能移植自 remotion/remotion-multimedia（MIT），已适配 miniQ。文中的工具名按 miniQ 原生工具理解：`shell_run` 执行命令、`browser_automation` 操作内置浏览器、`agent_run` 派发子代理、`ask_user` 询问用户、`mcp__<server>__<tool>` 调用本插件连接器、`skill_read` 读取其他技能及附属文件（相对路径以本技能目录为准）。原文针对 Codex 应用 Run 按钮 / `.codex/environments` 的步骤在 miniQ 中不适用，可跳过。

Mediabunny is a multimedia library for dealing with audio and video in the browser.
Here is a compact overview of its capabilities: https://mediabunny.dev/llms.txt

## Getting audio duration

See [get-audio-duration.md](get-audio-duration.md) for getting the duration of an audio file in seconds with Mediabunny.

## Getting video dimensions

See [get-video-dimensions.md](get-video-dimensions.md) for getting the width and height of a video file with Mediabunny.

## Getting video duration

See [get-video-duration.md](get-video-duration.md) for getting the duration of a video file in seconds with Mediabunny.
