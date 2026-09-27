---
name: ios-debugger-agent
description: Build, run, and debug iOS apps on Simulator with XcodeBuildMCP. Use when launching an app, inspecting simulator UI or logs, or diagnosing runtime behavior.
version: 1
origin: bundled
---

> 移植说明：本技能移植自 build-ios-apps/ios-debugger-agent（MIT），已适配 miniQ。文中的工具名按 miniQ 原生工具理解：`shell_run` 执行命令、`browser_automation` 操作内置浏览器、`agent_run` 派发子代理、`ask_user` 询问用户、`mcp__<server>__<tool>` 调用本插件连接器、`skill_read` 读取其他技能及附属文件（相对路径以本技能目录为准）。原文针对 Codex 应用 Run 按钮 / `.codex/environments` 的步骤在 miniQ 中不适用，可跳过。

# iOS Debugger Agent

## Overview
Use XcodeBuildMCP to build and run the current project scheme on a booted iOS simulator, interact with the UI, and capture logs. Prefer the MCP tools for simulator control, logs, and view inspection.

## Core Workflow
Follow this sequence unless the user asks for a narrower action.

### 1) Discover the booted simulator
- Call `mcp__xcodebuildmcp__list_sims` and select the simulator with state `Booted`.
- If none are booted, ask the user to boot one (do not boot automatically unless asked).

### 2) Set session defaults
- Call `mcp__xcodebuildmcp__session-set-defaults` with:
  - `projectPath` or `workspacePath` (whichever the repo uses)
  - `scheme` for the current app
  - `simulatorId` from the booted device
  - Optional: `configuration: "Debug"`, `useLatestOS: true`

### 3) Build + run (when requested)
- Call `mcp__xcodebuildmcp__build_run_sim`.
- **If the build fails**, check the error output and retry (optionally with `preferXcodebuild: true`) or escalate to the user before attempting any UI interaction.
- **After a successful build**, verify the app launched by calling `mcp__xcodebuildmcp__describe_ui` or `mcp__xcodebuildmcp__screenshot` before proceeding to UI interaction.
- If the app is already built and only launch is requested, use `mcp__xcodebuildmcp__launch_app_sim`.
- If bundle id is unknown:
  1) `mcp__xcodebuildmcp__get_sim_app_path`
  2) `mcp__xcodebuildmcp__get_app_bundle_id`

## UI Interaction & Debugging
Use these when asked to inspect or interact with the running app.

- **Describe UI**: `mcp__xcodebuildmcp__describe_ui` before tapping or swiping.
- **Tap**: `mcp__xcodebuildmcp__tap` (prefer `id` or `label`; use coordinates only if needed).
- **Type**: `mcp__xcodebuildmcp__type_text` after focusing a field.
- **Gestures**: `mcp__xcodebuildmcp__gesture` for common scrolls and edge swipes.
- **Screenshot**: `mcp__xcodebuildmcp__screenshot` for visual confirmation.

## Logs & Console Output
- Start logs: `mcp__xcodebuildmcp__start_sim_log_cap` with the app bundle id.
- Stop logs: `mcp__xcodebuildmcp__stop_sim_log_cap` and summarize important lines.
- For console output, set `captureConsole: true` and relaunch if required.

## Troubleshooting
- If build fails, ask whether to retry with `preferXcodebuild: true`.
- If the wrong app launches, confirm the scheme and bundle id.
- If UI elements are not hittable, re-run `describe_ui` after layout changes.
