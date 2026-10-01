---
name: remotion-best-practices
description: Router for all Remotion skills
version: 1
origin: bundled
---

> 移植说明：本技能移植自 remotion/remotion-best-practices（MIT），已适配 miniQ。文中的工具名按 miniQ 原生工具理解：`shell_run` 执行命令、`browser_automation` 操作内置浏览器、`agent_run` 派发子代理、`ask_user` 询问用户、`mcp__<server>__<tool>` 调用本插件连接器、`skill_read` 读取其他技能及附属文件（相对路径以本技能目录为准）。原文针对 Codex 应用 Run 按钮 / `.codex/environments` 的步骤在 miniQ 中不适用，可跳过。

## Creating a video

If the user asks to make, create, or build a new video or composition, load [Create a new Remotion video]（用 skill_read 读取技能 `remotion-create`）, whether or not a Remotion project already exists.

## New project setup

If no Remotion project currently exists, load [Create a new Remotion project]（用 skill_read 读取技能 `remotion-create`）

## React Markup Best Practices

If you are writing Remotion React Markup, load [Remotion Markup Best Practices]（用 skill_read 读取技能 `remotion-markup`）

## Maps

For static maps, animated routes and markers, geographic explainers, Mapbox, MapLibre, MapTiler, GeoJSON, or 3D geographic flyovers, load [Remotion Maps]（用 skill_read 读取技能 `remotion-maps`）.

## Multimedia

For achieving multimedia tasks in the browser, such as trimming, cropping videos, or getting metadata from them, load [Remotion Multimedia]（用 skill_read 读取技能 `remotion-multimedia`）

## Improving Interactivity

By structuring the Remotion markup well, we can allow users to interactively change things in the Studio and write back to code. If relevant: [Interactivity Best Practices]（用 skill_read 读取技能 `remotion-interactivity`）

## Rendering

For advanced rendering beyond simple `npx remotion render`, see: [Rendering Best Practices]（用 skill_read 读取技能 `remotion-render`）

## Opening Remotion Studio

To launch a project in Remotion Studio, open its exact local URL, or configure Studio CLI flags, load [Remotion Studio]（用 skill_read 读取技能 `remotion-studio`）.

## Captions

When working with Captions, load [Remotion Captions]（用 skill_read 读取技能 `remotion-captions`）.

## Creating a SaaS, automation or application

Use the [Remotion SaaS skill]（用 skill_read 读取技能 `remotion-saas`） for knowledge about Remotion-powered SaaS apps, such as `<Player>`, rendering on Lambda, Vercel, Cloudflare, via Express.js, client-side rendering, or for finding the right SaaS template.

## Looking up Remotion APIs and documentation

To find and read current Remotion documentation, load [Remotion Docs]（用 skill_read 读取技能 `remotion-docs`）.

## Upgrading

To upgrade Remotion, related packages, compatible Mediabunny packages, and installed Remotion Agent Skills, load [Remotion Upgrade]（用 skill_read 读取技能 `remotion-upgrade`）.


## Codex troubleshooting

When running inside miniQ, first try starting the Remotion Studio without opening the system browser:

```bash
npx remotion studio --no-open
```

Only if that fails with file watcher limits such as `EMFILE: too many open files, watch`, retry with polling and without opening a browser from miniQ:

```bash
npx remotion studio --no-open --webpack-poll 1000
```

If Studio still fails to start from miniQ, ask the user to start it manually from their macOS Terminal and then continue using the already-running Studio. Sandbox errors while launching Chromium from miniQ are likely caused by the Codex/macOS sandbox rather than the Remotion project.
