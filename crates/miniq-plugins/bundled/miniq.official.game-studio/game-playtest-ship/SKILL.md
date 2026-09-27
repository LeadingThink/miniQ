---
name: game-playtest-ship
description: 当用户要自动试玩网页游戏、截图检查画面与性能问题，或把游戏发布到 Vercel、Netlify、Cloudflare 时使用
origin: installed
---

## 适用场景

原型已能本地运行，需要验证可玩性、截取宣传或问题截图，并最终发布上线。

## 前置条件

- 本地 dev server 在运行，例如 `http://127.0.0.1:5173`，或已有 `dist/` 构建产物
- 发布需要对应平台的 CLI 登录，具体见复用的部署技能

## 步骤

1. **打开游戏**（`browser_automation`）：
   - 先 `open` 本地地址，再 `snapshot` 找到开始按钮或画布
   - 用 `click` 或 `press`（如 `Space`、`ArrowLeft`）开始游戏
2. **脚本化试玩**（`browser_automation`）：
   - 按 GDD 操作表发送按键序列，每隔 1–2 秒 `screenshot`，至少覆盖开局、中段、失败和重开
   - 若游戏暴露了 `window.__game`，就从页面读取分数和状态，确认计分与失败逻辑正确
3. **检查画面**（`view_image`）：逐张检查以下问题：
   - 素材缺失（紫黑格、空白）
   - 文字溢出
   - UI 被遮挡
   - 移动端尺寸下的布局。用 `browser_automation` 的 `resize` 设置为 390×844 再截一张
4. **检查控制台与性能**：
   - 用 `browser_automation` 的 `snapshot` 或页面状态查看错误
   - 必要时在游戏中加 FPS 计数，例如 Phaser 的 `this.game.loop.actualFps`，截图确认是否稳定在 50+
5. **修复与回归**：
   - 用 `file_edit` 修复发现的问题，再重复第 2–4 步
   - 把问题与修复记录到 `docs/playtest.md`（用 `file_write`）
6. **构建**（`shell_run`）：执行 `npm run build`，确认 `dist/index.html` 存在
7. **发布**：
   - 先用 `ask_user` 让用户选择平台，然后复用已有部署技能：
     - **vercel-deploy**：`npx vercel deploy dist`
     - **netlify-deploy**：`npx netlify deploy --dir=dist`
     - **cloudflare-deploy**：`npx wrangler pages deploy dist`
   - 默认先发预览地址
   - 生产发布（`--prod`）必须再次 `ask_user` 确认
8. **线上冒烟**（`browser_automation`）：打开预览或线上地址，重复一次开局截图

## 注意事项 / 安全

- 发布属于对外可见的副作用，每次都要先确认。
- 不在前端代码中写入任何密钥。排行榜等后端需求单独设计。
- 试玩截图可能包含用户未公开的作品，不要上传到第三方。

## 如何确认完成

有覆盖开局、中段、失败和重开的截图，并且已检查无明显问题。发布时拿到可访问的预览或线上 URL，冒烟截图正常。
