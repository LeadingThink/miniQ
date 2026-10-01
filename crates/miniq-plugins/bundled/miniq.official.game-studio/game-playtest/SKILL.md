---
name: game-playtest
displayName: 游戏试玩测试
description: Run browser-game playtests and frontend QA. Use when the user asks for smoke tests, screenshot-based verification, browser automation, HUD or overlay review, or structured issue-finding in a browser game.
version: 1
origin: bundled
---

> 移植说明：本技能移植自 game-studio/game-playtest（MIT），已适配 miniQ。文中的工具名按 miniQ 原生工具理解：`shell_run` 执行命令、`browser_automation` 操作内置浏览器、`agent_run` 派发子代理、`ask_user` 询问用户、`mcp__<server>__<tool>` 调用本插件连接器、`skill_read` 读取其他技能及附属文件（相对路径以本技能目录为准）。原文针对 Codex 应用 Run 按钮 / `.codex/environments` 的步骤在 miniQ 中不适用，可跳过。

# Game Playtest

## Overview

Use this skill to test browser games the way players experience them: through boot, input, scene transitions, HUD readability, and visual state changes. Prefer browser automation and screenshot review when the project supports it.

## Preferred Workflow

1. Boot the game and confirm the first actionable screen.
2. Exercise the main verbs.
3. Capture screenshots from representative states.
4. Check the UI layer independently from the render layer.
5. Report findings in severity order with reproduction steps.

## Tooling Guidance

- Prefer Playwright or equivalent browser automation already available in the repo.
- When the game is canvas or WebGL heavy, screenshots are mandatory because DOM assertions alone miss visual regressions.
- Use screenshots to judge playfield obstruction and HUD weight, not just correctness of text or layout.
- When deterministic automation is not practical, do a structured manual pass and capture evidence.
- For 3D rendering bugs or unexplained frame cost, use SpectorJS and browser performance tooling rather than guessing from code alone.

## Common Checks

### 2D checks

- sprite alignment and baseline consistency
- hit or hurt animation readability
- HUD overlap with the playfield
- command menu state changes
- tile or platform readability
- input-state feedback and turn-state clarity

### 3D checks

- first-load playability versus dashboard-like chrome
- persistent overlay weight versus playfield visibility
- camera control and camera reset behavior
- pointer-lock or drag-look transitions when menus and overlays open
- depth readability and silhouette clarity
- secondary panels collapsed or dismissible during normal play
- resize behavior
- WebGL context loss or renderer fallback behavior
- material or lighting regressions
- GLB or texture streaming stalls
- collision proxy or physics mismatch
- performance cliffs tied to post-processing or asset load

## Responsive and Browser Checks

- desktop and mobile viewport sanity
- safe-area and notch issues where relevant
- reduced-motion behavior for UI transitions
- keyboard, pointer, and pause-state handling
- React state and scene state synchronization when the project uses React Three Fiber

## Reporting Standard

Lead with findings. Keep each finding concrete:

- what the user sees
- how to reproduce it
- why it matters
- what likely subsystem owns it

## References

- Shared architecture: `../web-game-foundations/SKILL.md`
- Frontend review cues: `../game-ui-frontend/SKILL.md`
- 3D debugging notes: `../../references/webgl-debugging-and-performance.md`
- Full checklist: `../../references/playtest-checklist.md`
