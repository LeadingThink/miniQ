---
name: wechat-publish
displayName: 发布到公众号草稿箱
description: 当用户要把本地 Markdown 文章推送到微信公众号草稿箱（含自动上传图片、选择排版主题）时使用。依赖第三方命令行工具 wenyan-cli 与公众号开发者凭证；只能进草稿箱，不做群发。写文章本身用 wechat-article。
version: 1
origin: installed
requires:
  bins: [npm]
---

# 发布到公众号草稿箱

## 适用场景

用户说：
- "把这篇文章发到我的公众号草稿箱"
- "帮我用 lapis 主题把 公众号/2026-10-10-xxx.md 推到公众号"
- "文章写好了，上传到公众号后台，我自己再群发"

不适用：写文章（`wechat-article`）；直接群发（本技能做不到，也不应做）；没有公众号开发者权限的订阅号（需要先在公众号后台开通并获取 AppID / AppSecret）。

## 前置条件

1. **wenyan-cli**：用 `shell_run` 执行 `wenyan --help`；找不到命令时执行 `npm install -g @wenyan-md/cli`（npm 慢时提示 `npm config set registry https://registry.npmmirror.com`）。安装后再次 `wenyan --help` 确认，并以其输出为准决定参数写法。
2. **凭证**：daemon 环境需要 `WECHAT_APP_ID` 与 `WECHAT_APP_SECRET` 两个环境变量。用 `shell_run` 执行 `test -n "$WECHAT_APP_ID" && test -n "$WECHAT_APP_SECRET" && echo ok` 检查；缺失时告诉用户在 `~/.zshrc`（或启动 miniQ 的环境）中 `export` 后重启 miniQ。**不要让用户把 AppSecret 贴进对话**，也不要把它写进任何文件。
3. **IP 白名单**：公众号后台「设置与开发 → 基本配置 → IP 白名单」必须包含当前出口 IP。可用 `shell_run` 执行 `curl -s ifconfig.me` 取 IP 供用户填写。
4. **文章文件**：Markdown 顶部需有 frontmatter，`title` 与 `cover` 均必填（实测缺 cover 会报"未能找到文章封面"）：
   ```markdown
   ---
   title: 文章标题
   cover: ./cover.jpg      # 相对路径（相对于 md 文件）、绝对路径或 https 链接均可
   ---
   ```

## 步骤

1. 定位文章：用户给了路径就 `file_read`；没给则 `file_glob` 搜索 `公众号/*.md` 并用 `ask_user` 让用户选。
2. 检查 frontmatter：用 `file_read` 确认 `title`、`cover` 存在；封面文件若为本地路径用 `file_list` 确认存在。缺封面时给出两个选项（`ask_user`）：用 `poster-cn` / `generate_image` 生成一张 900×383 的封面，或用户提供图片路径。补齐后用 `file_edit` 写回 frontmatter。
3. 检查正文图片：用 `file_grep` 匹配 `!\[.*\]\(` 找出所有图片引用，本地路径逐一确认存在；wenyan 会自动把本地与网络图片上传到微信图床。
4. 选择主题：用 `shell_run` 执行 `wenyan theme -l` 列出可用主题（常见内置主题如 `default`、`lapis`、`phycat`，代码高亮如 `solarized-light`、`github`；以实际输出为准）。
5. **发布前确认（必做）**：用 `ask_user` 展示并确认 —— 标题、封面路径、排版主题、代码高亮主题、是否把链接转为脚注；并明确告知："本操作只会把文章存入公众号**草稿箱**，不会群发；群发请在公众号后台手动操作。"
6. 执行发布：用 `shell_run` 运行，参数以 `wenyan --help` 为准，典型形式：
   ```bash
   wenyan publish -f "<文章路径>" -t <主题> -h <代码高亮主题>
   ```
   可选 `--no-mac-style`（关闭 Mac 风格代码块）、`--no-footnote`（不把链接转脚注）。超时设为 120 秒以上（图片上传耗时）。
7. 读取输出：成功时记录返回的 media_id 或草稿链接；失败时按下方故障表处理，修复后再次 `ask_user` 确认后重试，最多两次。
8. 回复：告知"已进入草稿箱"，附文章标题、主题、上传图片数量，并提醒用户到 https://mp.weixin.qq.com/ 草稿箱预览后再决定群发。

## 常见故障

| 输出包含 | 处理 |
|---|---|
| `command not found` | 回到前置条件 1 安装 |
| `WECHAT_APP_ID is required` / `WECHAT_APP_SECRET` | 回到前置条件 2，提醒设置环境变量后重启 miniQ |
| `ip not in whitelist` / `40164` | 回到前置条件 3，给出当前 IP |
| `未能找到文章封面` / `cover` | 回到第 2 步补 `cover` |
| `title is required` | 回到第 2 步补 `title` |
| 图片上传失败 | 检查该图片路径是否存在、大小是否超过 10MB、格式是否为 jpg/png/gif |

## 注意事项 / 安全

- 发布到草稿箱是对外系统写操作，**必须**先 `ask_user` 确认；用户没有明确说"发布 / 推送 / 上传"时不要主动执行。
- 草稿可在后台删除，但已上传到微信图床的图片不会自动回收；告知用户。
- 永远不在回复、日志或文件中回显 AppSecret；`shell_run` 命令里也不要内联凭证，依赖环境变量即可。
- 同一篇文章重复发布会在草稿箱产生多份，重试前先询问用户是否已有成功的草稿。
- 本技能不负责群发、不负责修改公众号任何设置。

## 如何确认完成

`wenyan publish` 退出码为 0 且输出含成功信息；回复中写明标题、主题、草稿箱提示，以及"草稿箱≠群发"的说明。
