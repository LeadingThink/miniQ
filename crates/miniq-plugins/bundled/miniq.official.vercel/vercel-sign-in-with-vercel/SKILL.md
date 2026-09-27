---
name: vercel-sign-in-with-vercel
description: Sign in with Vercel guidance — OAuth 2.0/OIDC identity provider for user authentication via Vercel accounts. Use when implementing user login with Vercel as the identity provider.
version: 1
origin: bundled
---

> 移植说明：本技能移植自 vercel/sign-in-with-vercel（Apache-2.0），已适配 miniQ。文中的工具名按 miniQ 原生工具理解：`shell_run` 执行命令、`browser_automation` 操作内置浏览器、`agent_run` 派发子代理、`ask_user` 询问用户、`mcp__<server>__<tool>` 调用本插件连接器、`skill_read` 读取其他技能及附属文件（相对路径以本技能目录为准）。原文针对 Codex 应用 Run 按钮 / `.codex/environments` 的步骤在 miniQ 中不适用，可跳过。

# Sign in with Vercel

You are an expert in Sign in with Vercel — Vercel's OAuth 2.0 / OpenID Connect identity provider.

## What It Is

Sign in with Vercel lets users log in to your application using their **Vercel account**. Your app does not need to handle passwords, create accounts, or manage user sessions — Vercel acts as the identity provider (IdP).

## OAuth 2.0 Authorization Code Flow

```
1. User clicks "Sign in with Vercel"
2. Redirect to Vercel authorization URL
3. User grants consent on Vercel's consent page
4. Vercel redirects back with authorization code
5. Exchange code for tokens (ID Token + Access Token + Refresh Token)
```

## Tokens

| Token | Lifetime | Purpose |
|-------|----------|---------|
| **ID Token** | Signed JWT | Proves user identity (name, email, avatar) |
| **Access Token** | 1 hour | Bearer token for Vercel REST API calls |
| **Refresh Token** | 30 days | Silent re-authentication (rotates on use) |

## Configuration

1. Register your app at `https://vercel.com/dashboard/{team}/integrations/console` (the Integrations Console). Click **Create Integration** → fill in the OAuth details → note the Client ID and Client Secret.
2. Configure redirect URIs and scopes
3. Use any standard OAuth 2.0 client library (no Vercel-specific SDK required)

## When to Use

- Build tools/dashboards that need Vercel account identity
- Grant users access to their own Vercel resources via your app
- Developer-facing apps where users already have Vercel accounts

## When NOT to Use

- General-purpose user auth (not everyone has Vercel) → use Clerk, Auth0
- Machine-to-machine auth → use Vercel OIDC Federation or API tokens
- Internal team auth → use Teams & Access Control

## References

- 📖 docs: https://vercel.com/docs/sign-in-with-vercel
