import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import {
  getTaskNotificationPermission,
  requestTaskNotificationPermission,
  sendTaskNotificationTest,
  setTaskNotificationMode,
  useTaskNotificationMode,
  type TaskNotificationMode,
  type TaskNotificationPermission,
} from "../taskNotifications";

export function TaskNotificationSettings() {
  const mode = useTaskNotificationMode();
  const [permission, setPermission] = useState<TaskNotificationPermission | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void getTaskNotificationPermission().then((value) => {
        if (active) setPermission(value);
      }).catch(() => {
        if (active) setStatus("暂时无法读取通知权限，请稍后重试。");
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, []);

  const enable = async () => {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await requestTaskNotificationPermission();
      setPermission(result);
      if (result === "granted") {
        const sent = await sendTaskNotificationTest();
        setStatus(sent ? "测试通知已发送，请在系统通知中查看。" : "测试通知未能发送，请检查系统通知设置后重试。");
      } else {
        setStatus(result === "unsupported"
          ? "当前环境不支持系统通知。"
          : "通知权限未开启，请在系统或浏览器的通知设置中允许 miniQ。后台任务不会反复请求授权。");
      }
    } catch {
      setStatus("无法启用通知，请检查系统通知设置后重试。");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section provider-settings" aria-label="任务通知">
      <div>
        <div className="settings-section-title"><Bell size={15} /><span>任务通知</span></div>
        <p className="settings-section-description">仅在 miniQ 窗口未处于焦点时提醒；不展示原始错误详情。设置会保留在这台设备上。</p>
      </div>
      <label htmlFor="task-notification-mode">
        通知方式
        <select
          id="task-notification-mode"
          value={mode}
          onChange={(event) => {
            try {
              setTaskNotificationMode(event.target.value as TaskNotificationMode);
              setStatus(null);
            } catch {
              setStatus("无法保存通知设置，请检查本机存储是否可用。");
            }
          }}
        >
          <option value="all">后台完成及失败</option>
          <option value="failures">仅失败</option>
          <option value="off">关闭</option>
        </select>
      </label>
      {mode !== "off" && <div className="settings-actions">
        <button type="button" className="secondary" disabled={busy || permission === "unsupported"} onClick={() => void enable()}>
          <Bell size={14} />
          {busy ? "正在检查…" : permission === "granted" ? "发送测试通知" : "启用系统通知"}
        </button>
      </div>}
      {permission === "unsupported" && <p className="settings-section-description">当前环境不支持系统通知。</p>}
      {status && <p role="status">{status}</p>}
    </section>
  );
}
