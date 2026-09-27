# 看板运行时说明（board-runtime）

## 目录与文件
```
creative/board/
├── board.json   # 唯一数据源
├── board.html   # render 生成，可随时重建
└── board.lock   # 写入期间存在的临时锁，正常结束后删除
```

## board.json 结构
```json
{
  "schema": "miniq.creative-board/1",
  "boardId": "<uuid>",
  "title": "项目名",
  "summary": "一句话目标",
  "revision": 12,
  "items": [
    {
      "id": "ads-01-hero",
      "label": "英雄主图",
      "direction": "英雄主图",
      "mode": "ads",
      "tool": "generate_image",
      "prompt": "完整提示词",
      "parentId": "",
      "status": "pending | done | failed",
      "selection": "none | selected | rejected",
      "attempts": 1,
      "image": "/真实/绝对/路径.png",
      "kind": "image | video | audio",
      "width": 1024, "height": 1280,
      "error": "", "note": "",
      "created": "...", "updated": "..."
    }
  ],
  "events": [{"time": "...", "kind": "note|decision|...", "message": "...", "itemId": "..."}]
}
```
- `revision` 每次写入 +1，可用于判断子任务是否已写入。
- `events` 最多保留最近 500 条。
- `image` 保存为真实路径（解析符号链接，例如 macOS 的 `/tmp` → `/private/tmp`），渲染 HTML 时换算为相对路径。

## 状态流转
```
begin → pending ──complete──▶ done
           │                   │
           └──fail──▶ failed ──retry──▶ pending（attempts+1，可附新 prompt）
done 也可 retry（用户要求重做时）
selection 与 status 独立：select / reject / unmark
```

## 并发
- 写操作先以 O_EXCL 方式创建 `board.lock`，拿不到锁时短暂等待；锁文件超过 120 秒视为残留并清除。
- 写入先落到临时文件，再 `os.replace` 原子替换，读者不会读到半个文件。
- 因此多个 `agent_run` 子任务可以同时 `complete`/`fail`/`log`。结构性操作（`init --force`、`delete`）只由主会话执行。

## 渲染视图（review rendering）
- `grid`（默认）：按方向分组的卡片网格；每张卡片显示状态徽标（生成中 / 完成 / 失败）、★已选或已否标记、ID、模式、尺寸、相对路径和可折叠提示词。
  - `--group auto`：若每个方向都只有一张，合并为一组，避免大量只有一张卡的小标题；`direction` 始终分组；`none` 不分组。
- `compare`：只展示已选中的完成项（无选中时展示全部完成项），大图并排，用于终选。
- 视频以 `<video controls>`、音频以 `<audio controls>` 嵌入；失败项显示原因；pending 显示占位。
- HTML 自包含（内联 CSS，无外部脚本 / 字体），可离线打开，也可与图片一起打包发送。

## 目视核验
1. `browser_automation`：`open` → `file:///绝对路径/creative/board/board.html` → `screenshot`，检查破图与布局。
2. 或 `render.sh board.html 1400x900 board.png` 后 `view_image`。长看板可增大高度，或用 `--only-selected` 分批看。

## 常见问题
| 现象 | 原因 / 处理 |
| --- | --- |
| 图片破图 | 图片被移动或删除；重新 `complete --image` 新路径 |
| “条目不存在” | ID 拼写不一致；`read` 查看实际 ID |
| begin 返回 `skipped` | 该 ID 已存在，未覆盖；换 ID，或先 delete 再 begin |
| 看板被占用 | 其他进程写入中，稍后重试 |
