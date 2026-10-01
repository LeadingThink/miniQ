---
name: vercel-cron-jobs
description: Vercel Cron Jobs configuration and best practices. Use when adding, editing, or debugging scheduled tasks in vercel.json.
version: 1
origin: bundled
---

> 移植说明：本技能移植自 vercel/cron-jobs（Apache-2.0），已适配 miniQ。文中的工具名按 miniQ 原生工具理解：`shell_run` 执行命令、`browser_automation` 操作内置浏览器、`agent_run` 派发子代理、`ask_user` 询问用户、`mcp__<server>__<tool>` 调用本插件连接器、`skill_read` 读取其他技能及附属文件（相对路径以本技能目录为准）。原文针对 Codex 应用 Run 按钮 / `.codex/environments` 的步骤在 miniQ 中不适用，可跳过。

# Vercel Cron Jobs

You are an expert in Vercel Cron Jobs — scheduled serverless function invocations configured in `vercel.json`.

## Configuration

Cron jobs are defined in the `crons` array of `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron/daily-digest",
      "schedule": "0 8 * * *"
    }
  ]
}
```

## Key Rules

1. **Path must be an API route** — the `path` field must point to a serverless function endpoint (e.g., `/api/cron/...`)
2. **Schedule uses standard cron syntax** — five-field format: `minute hour day-of-month month day-of-week`
3. **Verify the request origin** — always check the `Authorization` header matches `CRON_SECRET`:

```ts
// app/api/cron/route.ts
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  // ... your scheduled logic
  return Response.json({ ok: true });
}
```

4. **Hobby plan limits** — max 2 cron jobs, minimum interval of once per day
5. **Pro plan** — up to 40 cron jobs, minimum interval of once per minute
6. **Max duration** — cron-triggered functions follow normal function duration limits

## Common Patterns

- **Daily digest**: `"0 8 * * *"` (8:00 AM UTC daily)
- **Every hour**: `"0 * * * *"`
- **Every 5 minutes** (Pro): `"*/5 * * * *"`
- **Weekdays only**: `"0 9 * * 1-5"`

## Debugging

- Check deployment logs for cron execution results
- Use `vercel logs --follow` to watch cron invocations in real time
- Cron jobs only run on production deployments, not preview deployments

## References

- [Cron Jobs documentation](https://vercel.com/docs/cron-jobs)
