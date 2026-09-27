---
name: macos-test-triage
description: Triage macOS tests across Xcode and SwiftPM. Use when narrowing failures, explaining assertions or crashes, or separating setup from regressions.
version: 1
origin: bundled
---

> 移植说明：本技能移植自 build-macos-apps/test-triage（MIT），已适配 miniQ。文中的工具名按 miniQ 原生工具理解：`shell_run` 执行命令、`browser_automation` 操作内置浏览器、`agent_run` 派发子代理、`ask_user` 询问用户、`mcp__<server>__<tool>` 调用本插件连接器、`skill_read` 读取其他技能及附属文件（相对路径以本技能目录为准）。原文针对 Codex 应用 Run 按钮 / `.codex/environments` 的步骤在 miniQ 中不适用，可跳过。

# Test Triage

## Quick Start

Use this skill to run the smallest meaningful test scope first, classify
failures precisely, and avoid treating every test failure like a product bug.

## Workflow

1. Detect the test harness.
   - Use `xcodebuild test` for Xcode-based projects.
   - Use `swift test` for SwiftPM packages.

2. Narrow the scope.
   - If the user gave a target, product, or test filter, use it.
   - If not, prefer the smallest likely failing target before a full suite.

3. Classify the result.
   - Build failure
   - Assertion failure
   - Crash or signal
   - Async timing or flake
   - Environment or fixture setup issue
   - Missing entitlement or host app issue

4. Rerun intelligently.
   - Use focused reruns when a specific case fails.
   - Avoid burning time on full-suite reruns without new information.

5. Summarize clearly.
   - What command ran
   - Which tests failed
   - What kind of failure it was
   - The best next proof step or fix path

## Guardrails

- Distinguish compilation failures from test execution failures.
- Call out when a test appears to assume iOS-only or simulator-only behavior.
- Mark likely flakes as such instead of overstating confidence.

## Output Expectations

Provide:
- the command used
- the smallest failing scope
- the top failure category
- a concise explanation of the likely cause
- the next rerun or fix step
