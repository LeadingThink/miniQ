---
name: remotion-docs
displayName: Remotion 文档查询
description: Search Remotion documentation
version: 1
origin: bundled
---

> 移植说明：本技能移植自 remotion/remotion-docs（MIT），已适配 miniQ。文中的工具名按 miniQ 原生工具理解：`shell_run` 执行命令、`browser_automation` 操作内置浏览器、`agent_run` 派发子代理、`ask_user` 询问用户、`mcp__<server>__<tool>` 调用本插件连接器、`skill_read` 读取其他技能及附属文件（相对路径以本技能目录为准）。原文针对 Codex 应用 Run 按钮 / `.codex/environments` 的步骤在 miniQ 中不适用，可跳过。

This skill teaches you how to discover and read current Remotion documentation.
If this is not relevant, load [Remotion Best Practices]（用 skill_read 读取技能 `remotion-best-practices`） instead.

## Searching the docs

Use the Algolia search API to find relevant documentation pages:

```
POST https://plsduol1ca-dsn.algolia.net/1/indexes/*/queries?x-algolia-api-key=3e42dbd4f895fe93ff5cf40d860c4a85&x-algolia-application-id=PLSDUOL1CA
Content-Type: application/x-www-form-urlencoded

{
  "requests": [
    {
      "query": "<your search query>",
      "indexName": "remotion",
      "params": "attributesToRetrieve=[\"hierarchy.lvl0\",\"hierarchy.lvl1\",\"hierarchy.lvl2\",\"url\"]&hitsPerPage=10"
    }
  ]
}
```

Each hit contains a `url` field pointing to the documentation page.

## Fetching a page as Markdown

Append `.md` to any Remotion docs URL to retrieve its Markdown source (saves tokens):

```
https://www.remotion.dev/docs/use-video-config.md
https://www.remotion.dev/docs/sequence.md
https://www.remotion.dev/docs/lambda/rendermediaonlambda.md
```

## Workflow

1. Search Algolia for the concept or API you need.
2. Pick the most relevant URL(s) from the results.
3. Fetch each URL with the `.md` suffix.
4. Implement using the current documentation rather than memorized API knowledge.
