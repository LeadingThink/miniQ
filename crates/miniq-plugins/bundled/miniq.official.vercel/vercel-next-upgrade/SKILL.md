---
name: vercel-next-upgrade
description: Upgrade Next.js to the latest version following official migration guides and codemods. Use when upgrading Next.js versions, running codemods, or migrating between major releases.
version: 1
origin: bundled
---

> 移植说明：本技能移植自 vercel/next-upgrade（Apache-2.0），已适配 miniQ。文中的工具名按 miniQ 原生工具理解：`shell_run` 执行命令、`browser_automation` 操作内置浏览器、`agent_run` 派发子代理、`ask_user` 询问用户、`mcp__<server>__<tool>` 调用本插件连接器、`skill_read` 读取其他技能及附属文件（相对路径以本技能目录为准）。原文针对 Codex 应用 Run 按钮 / `.codex/environments` 的步骤在 miniQ 中不适用，可跳过。

# Upgrade Next.js

Upgrade the current project to the latest Next.js version following official migration guides.

## Instructions

1. **Detect current version**: Read `package.json` to identify the current Next.js version and related dependencies (React, React DOM, etc.)

2. **Fetch the latest upgrade guide**: Use WebFetch to get the official upgrade documentation:
   - Codemods: https://nextjs.org/docs/app/guides/upgrading/codemods
   - Version-specific guides (adjust version as needed):
     - https://nextjs.org/docs/app/guides/upgrading/version-16
     - https://nextjs.org/docs/app/guides/upgrading/version-15
     - https://nextjs.org/docs/app/guides/upgrading/version-14

3. **Determine upgrade path**: Based on current version, identify which migration steps apply. For major version jumps, upgrade incrementally (e.g., 13 → 14 → 15).

4. **Run codemods first**: Next.js provides codemods to automate breaking changes:
   ```bash
   npx @next/codemod@latest <transform> <path>
   ```
   Common transforms:
   - `next-async-request-api` - Updates async Request APIs (v15)
   - `next-request-geo-ip` - Migrates geo/ip properties (v15)
   - `next-dynamic-access-named-export` - Transforms dynamic imports (v15)

5. **Update dependencies**: Upgrade Next.js and peer dependencies together:
   ```bash
   npm install next@latest react@latest react-dom@latest
   ```

6. **Review breaking changes**: Check the upgrade guide for manual changes needed:
   - API changes (e.g., async params in v15)
   - Configuration changes in `next.config.js`
   - Deprecated features being removed

7. **Update TypeScript types** (if applicable):
   ```bash
   npm install @types/react@latest @types/react-dom@latest
   ```

8. **Test the upgrade**:
   - Run `npm run build` to check for build errors
   - Run `npm run dev` and test key functionality
