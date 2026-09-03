import { useEffect, useRef } from "react";
import type { RpcClient } from "../rpc";
import type { Session } from "../types";
import { isTauriRuntime } from "../runtime";

async function notify(title: string, body: string) {
  if (isTauriRuntime()) {
    try {
      const plugin = await import("@tauri-apps/plugin-notification");
      let granted = await plugin.isPermissionGranted();
      if (!granted) {
        granted = (await plugin.requestPermission()) === "granted";
      }
      if (granted) plugin.sendNotification({ title, body });
      return;
    } catch {
      /* fall through to web Notification */
    }
  }
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
  if (Notification.permission === "granted") {
    new Notification(title, { body });
  }
}

/**
 * System notification when a turn finishes while the window is unfocused —
 * mirrors the ChatGPT desktop "assistant finished replying in the background"
 * notification, useful for long-running agent tasks.
 */
export function useTaskNotifications(client: RpcClient, sessions: Session[]) {
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  useEffect(() => {
    return client.onEvent((event) => {
      if (event.type !== "turn_completed" && event.type !== "turn_failed") return;
      if (document.hasFocus()) return;
      const session = sessionsRef.current.find((s) => s.id === event.sessionId);
      const title = session?.title || "miniQ";
      if (event.type === "turn_completed") {
        void notify("任务完成", `「${title}」已完成,点击窗口查看结果。`);
      } else {
        void notify("任务失败", `「${title}」执行出错:${event.error}`);
      }
    });
  }, [client]);
}
