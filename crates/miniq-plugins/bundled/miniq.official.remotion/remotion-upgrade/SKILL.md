---
name: remotion-upgrade
displayName: 升级 Remotion
description: Upgrade Remotion, and related packages
version: 1
origin: bundled
---

> 移植说明：本技能移植自 remotion/remotion-upgrade（MIT），已适配 miniQ。文中的工具名按 miniQ 原生工具理解：`shell_run` 执行命令、`browser_automation` 操作内置浏览器、`agent_run` 派发子代理、`ask_user` 询问用户、`mcp__<server>__<tool>` 调用本插件连接器、`skill_read` 读取其他技能及附属文件（相对路径以本技能目录为准）。原文针对 Codex 应用 Run 按钮 / `.codex/environments` 的步骤在 miniQ 中不适用，可跳过。

# Upgrade Remotion

1. Inspect the project manifests and lockfile to identify the package manager and workspaces. Preserve unrelated changes.
2. Determine whether `@remotion/cli` is locally available. If it is, run:

   ```bash
   npx remotion upgrade
   ```

   This also updates project-local Remotion skills. Skip the manual upgrade below.

3. If `@remotion/cli` is not available, upgrade manually:
   - Get the latest stable Remotion version with `npm view remotion version`.
   - Find every installed `remotion` and `@remotion/*` dependency across the project and upgrade them all to that exact version. Preserve their dependency sections and the project's workspace or catalog conventions.
   - Read the current [Mediabunny compatibility page](https://www.remotion.dev/docs/mediabunny/version) and determine the Mediabunny version compatible with the target Remotion version. Upgrade every installed `mediabunny` and `@mediabunny/*` package to the documented compatible version.
   - Run the project's package manager to update its lockfile.
4. If `@remotion/cli` is not available, update the installed Remotion skills:

   ```bash
   npx skills update remotion-best-practices remotion-captions remotion-create remotion-docs remotion-interactivity remotion-maps remotion-markup remotion-multimedia remotion-render remotion-saas remotion-studio remotion-upgrade --yes
   ```

5. Review the manifest and lockfile diff. Ensure all Remotion packages use one version and all installed Mediabunny packages use the compatible version. If the CLI is available, run `npx remotion versions` as an additional check.

The [Remotion releases](https://github.com/remotion-dev/remotion/releases) contain the changelog and may be useful for summarizing relevant changes after the upgrade.
