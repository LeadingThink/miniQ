package com.leadingthink.miniq.push;

import org.json.JSONObject;

/** Notification text for a decrypted payload. Mirrors copy() in src/taskNotifications.ts. */
public final class MiniqPushText {
    public final String kind;
    public final String title;
    public final String body;
    public final String sessionId;
    public final String approvalId;
    public final String desktopDeviceId;
    public final String roomId;

    public String sessionKey() { return roomId + ":" + desktopDeviceId + ":" + sessionId; }

    private MiniqPushText(String kind, String title, String body, String sessionId, String approvalId, String desktopDeviceId, String roomId) {
        this.kind = kind;
        this.title = title;
        this.body = body;
        this.sessionId = sessionId;
        this.approvalId = approvalId;
        this.desktopDeviceId = desktopDeviceId;
        this.roomId = roomId;
    }

    public static MiniqPushText from(JSONObject payload) {
        if (payload == null) return null;
        String sessionId = payload.optString("sessionId", "");
        if (sessionId.isEmpty()) return null;
        String kind = payload.optString("kind", "");
        String rawName = payload.optString("title", "");
        String name = rawName.isEmpty() ? "当前会话" : rawName;
        String approval = payload.optString("approvalId", "");
        String desktopDeviceId = payload.optString("desktopDeviceId", "");
        String roomId = payload.optString("roomId", "");
        if (payload.optInt("v", 1) == 2 && (desktopDeviceId.isEmpty() || roomId.isEmpty())) return null;
        String approvalId = approval.isEmpty() || desktopDeviceId.isEmpty() || roomId.isEmpty() ? null : approval;
        switch (kind) {
            case "attention": {
                if (approvalId != null) {
                    String tool = payload.optString("toolName", "");
                    String reason = payload.optString("reason", "");
                    String text = tool.isEmpty()
                        ? "「" + name + "」请求执行操作，等待你批准。"
                        : "「" + name + "」请求使用 " + tool + "，等待你批准。";
                    if (!reason.isEmpty()) text += "\n" + reason;
                    return new MiniqPushText(kind, "miniQ · 需要你操作", text, sessionId, approvalId, desktopDeviceId, roomId);
                }
                return new MiniqPushText(kind, "miniQ · 需要你操作", "「" + name + "」正在等待你的回答，请返回 miniQ 处理。", sessionId, null, desktopDeviceId, roomId);
            }
            case "completed":
                return new MiniqPushText(kind, "miniQ · 任务完成", "「" + name + "」已完成，请返回 miniQ 查看结果。", sessionId, approvalId, desktopDeviceId, roomId);
            case "failed": {
                String error = payload.optString("error", "");
                String text = error.isEmpty()
                    ? "「" + name + "」执行未完成，请返回 miniQ 查看详情并继续任务。"
                    : "「" + name + "」执行未完成：" + error;
                return new MiniqPushText(kind, "miniQ · 任务未完成", text, sessionId, approvalId, desktopDeviceId, roomId);
            }
            default:
                return null;
        }
    }
}
