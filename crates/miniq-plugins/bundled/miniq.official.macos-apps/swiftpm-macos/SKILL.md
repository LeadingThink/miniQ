---
name: swiftpm-macos
displayName: macOS SwiftPM 开发
description: Build, run, and test SwiftPM macOS packages and executables. Use when the repo is package-first or has no Xcode project.
version: 1
origin: bundled
---

> 移植说明：本技能移植自 build-macos-apps/swiftpm-macos（MIT），已适配 miniQ。文中的工具名按 miniQ 原生工具理解：`shell_run` 执行命令、`browser_automation` 操作内置浏览器、`agent_run` 派发子代理、`ask_user` 询问用户、`mcp__<server>__<tool>` 调用本插件连接器、`skill_read` 读取其他技能及附属文件（相对路径以本技能目录为准）。原文针对 Codex 应用 Run 按钮 / `.codex/environments` 的步骤在 miniQ 中不适用，可跳过。

# SwiftPM for macOS

## Quick Start

Use this skill when `Package.swift` is the primary entrypoint or when SwiftPM is
the fastest path to a reproducible result.

## Workflow

1. Inspect the package.
   - Read `Package.swift`.
   - Identify executable, library, and test products.

2. Build with SwiftPM.
   - Use `swift build` by default.
   - Use release mode only when the user explicitly needs it.

3. Run the right product.
   - Use `swift run <product>` when an executable exists.
   - If multiple executables exist, explain the default choice.

4. Test narrowly.
   - Use `swift test`.
   - Apply filters when a specific test target or case is known.

5. Summarize failures.
   - Module/import resolution
   - Package graph or dependency issue
   - Linker failure
   - Runtime failure
   - Test regression

## Guardrails

- Prefer SwiftPM over Xcode when both exist and the package path is clearly simpler.
- Do not assume an app bundle exists in a pure package workflow.
- Explain when the package is library-only and therefore not directly runnable.

## Output Expectations

Provide:
- the package products you found
- the command you ran
- whether build, run, or test succeeded
- the top blocker if not
