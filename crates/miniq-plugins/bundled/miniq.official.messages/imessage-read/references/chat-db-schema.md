# chat.db 结构速查（只读）

所有查询都必须这样打开数据库：`sqlite3 -readonly ~/Library/Messages/chat.db`，或者用 Python 的 `file:...?mode=ro` URI。

## 关键表
| 表 | 用途 | 常用列 |
|---|---|---|
| `message` | 每条消息 | `ROWID`、`date`（2001 纪元）、`text`、`attributedBody`（富文本二进制）、`is_from_me`、`is_read`、`handle_id`、`cache_has_attachments`、`associated_message_type`（点回应/表情回应，非 0 表示“回应”而不是正文）、`thread_originator_guid`（回复线程） |
| `handle` | 对方账号 | `ROWID`、`id`（手机号或邮箱）、`service` |
| `chat` | 会话 | `ROWID`、`chat_identifier`（单聊是号码，群聊是 `chatNNN`）、`display_name`（群名，可能为空）、`service_name`、`guid`（AppleScript 中的 chat id 通常形如 `iMessage;+;chat123` 或 `iMessage;-;+86138...`） |
| `chat_message_join` | 会话 ↔ 消息 | `chat_id`、`message_id` |
| `chat_handle_join` | 会话 ↔ 参与者 | `chat_id`、`handle_id` |
| `attachment` | 附件 | `filename`（以 `~/Library/Messages/Attachments/` 开头）、`transfer_name`、`mime_type`、`total_bytes` |
| `message_attachment_join` | 消息 ↔ 附件 | `message_id`、`attachment_id` |

## 时间换算
- macOS 10.13 及以后，`message.date` 是自 2001-01-01 起的**纳秒**；旧数据是秒（数值小于 1e11）。
- 转本地时间：`datetime(m.date/1000000000 + 978307200, 'unixepoch', 'localtime')`。
- 按日期过滤：`m.date >= (strftime('%s','2025-06-01','utc') - 978307200) * 1000000000`。注意时区：脚本用本地零点换算，SQL 示例用 UTC。

## attributedBody 解码
新系统中很多消息的 `text` 为 NULL，正文存放在 `attributedBody`（NSAttributedString 的 typedstream）。解码步骤：
1. 找到字节串 `NSString`。
2. 在它之后找到第一个 `+`（0x2B）。
3. 下一个字节是长度：`0x81`、`0x82`、`0x83` 分别表示随后 2、3、4 字节的小端长度。
4. 按长度读取 UTF-8。

纯 SQL 做不到这一步，只能用脚本里的 `decode_attributed_body`。

## 常用 SQL
```sql
-- 某会话最近 50 条
SELECT datetime(m.date/1000000000 + 978307200,'unixepoch','localtime') AS t,
       CASE m.is_from_me WHEN 1 THEN '我' ELSE h.id END AS who, m.text
FROM message m
LEFT JOIN handle h ON h.ROWID = m.handle_id
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
WHERE cmj.chat_id = 12 AND m.associated_message_type = 0
ORDER BY m.date DESC LIMIT 50;

-- 各会话未读数
SELECT c.ROWID, COALESCE(NULLIF(c.display_name,''), c.chat_identifier) AS name, COUNT(*) AS unread
FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c ON c.ROWID = cmj.chat_id
WHERE m.is_read = 0 AND m.is_from_me = 0 GROUP BY c.ROWID ORDER BY unread DESC;

-- 本周每人发言数
SELECT COALESCE(h.id,'我') AS who, COUNT(*) FROM message m
LEFT JOIN handle h ON h.ROWID = m.handle_id
WHERE m.date >= (strftime('%s','now','-7 days') - 978307200) * 1000000000
GROUP BY who ORDER BY 2 DESC;
```

## 常见陷阱
- 同一个人可能对应多个 handle（手机号、邮箱各一条），统计时要合并。
- `is_read` 只对收到的消息有意义。
- 表情回应（“赞”“哈哈”）是一条独立的 message，`associated_message_type` 在 2000–3007 之间；总结时应过滤或单独统计。
- 数据库处于 WAL 模式，最新几秒的消息可能还在 `chat.db-wal` 中；只读连接会一并读到，不需要额外处理。
