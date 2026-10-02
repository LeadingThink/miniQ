import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import { Switch } from "./ui/Switch";
import {
  getTaskNotificationPermission,
  requestTaskNotificationPermission,
  sendTaskNotificationTest,
  setAttentionNotificationPref,
  setTaskNotificationMode,
  useAttentionNotificationPrefs,
  setTaskAttentionEnabled,
  useTaskAttentionEnabled,
  useTaskNotificationMode,
  type AttentionKind,
  type TaskNotificationMode,
  type TaskNotificationPermission,
} from "../taskNotifications";
import { isNativeMobileApp } from "../mobileRuntime";
import { refreshRemotePush, requestRemotePushPermission, useRemotePushStatus, type RemotePushStatus } from "../remotePush";
import { setQuietHours, useQuietHours } from "../quietHours";

const DEFAULT_QUIET = { start: "23:00", end: "08:00" };
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const PUSH_COPY: Record<Exclude<RemotePushStatus, "off">, string> = {
  active: "离线推送已开启：App 被关闭或被系统挂起后，也能收到任务完成和需要你操作的提醒。",
  registering: "正在开启离线推送…",
  needs_permission: "离线推送未开启：需要允许 miniQ 发送通知。",
  denied: "通知权限已被关闭，请到手机「设置 › 通知 › miniQ」中允许通知，App 在后台时才能提醒你。",
  server_disabled: "中转服务器未配置推送服务：App 刚切到后台时仍会提醒，但被系统挂起后可能收不到。",
  error: "离线推送注册失败，下次打开 App 或重新连接时会自动重试。",
  unsupported: "离线推送暂不可用：尚未连接电脑，或当前安装包不包含推送模块。App 在后台运行时仍会提醒。",
};

function RemotePushStatusRow({ onStatus }: { onStatus: (text: string) => void }) {
  const status = useRemotePushStatus();
  const [busy, setBusy] = useState(false);
  if (status === "off") return null;
  const allow = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const granted = await requestRemotePushPermission();
      if (!granted) onStatus("通知权限未开启，请在手机系统设置中允许 miniQ 发送通知。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="remote-access-toggle" data-push-status={status}>
      <span>
        <strong>离线推送</strong>
        <small role="note">{PUSH_COPY[status]}</small>
      </span>
      {status === "needs_permission" && <button type="button" className="secondary" disabled={busy} onClick={() => void allow()}>
        {busy ? "请求中…" : "允许通知"}
      </button>}
      {status === "error" && <button type="button" className="secondary" onClick={() => refreshRemotePush()}>重试</button>}
    </div>
  );
}

function QuietHoursSetting({ onStatus }: { onStatus: (text: string | null) => void }) {
  const quiet = useQuietHours();
  const save = (value: { start: string; end: string } | null) => {
    try {
      setQuietHours(value);
      onStatus(null);
    } catch {
      onStatus("无法保存免打扰时段，请检查本机存储是否可用。");
    }
  };
  const update = (field: "start" | "end", value: string) => {
    if (!quiet || !TIME.test(value)) return;
    save({ start: quiet.start, end: quiet.end, [field]: value });
  };
  return (
    <>
      <label className="remote-access-toggle" htmlFor="task-notification-quiet">
        <span>
          <strong>免打扰时段</strong>
          <small>时段内的提醒照常送达通知中心，但不响铃、不震动、不弹横幅</small>
        </span>
        <input
          id="task-notification-quiet"
          type="checkbox"
          checked={quiet !== null}
          onChange={(event) => save(event.target.checked ? DEFAULT_QUIET : null)}
        />
      </label>
      {quiet && <div className="task-quiet-hours">
        <label htmlFor="task-notification-quiet-start">
          开始
          <input id="task-notification-quiet-start" type="time" value={quiet.start} onChange={(event) => update("start", event.target.value)} />
        </label>
        <label htmlFor="task-notification-quiet-end">
          结束
          <input id="task-notification-quiet-end" type="time" value={quiet.end} onChange={(event) => update("end", event.target.value)} />
        </label>
        <small>{quiet.start === quiet.end
          ? "开始和结束相同，表示全天免打扰。"
          : quiet.start > quiet.end ? `每天 ${quiet.start} 至次日 ${quiet.end}` : `每天 ${quiet.start} 至 ${quiet.end}`}</small>
      </div>}
    </>
  );
}

export function TaskNotificationSettings() {
  const mode = useTaskNotificationMode();
  const attentionPrefs = useAttentionNotificationPrefs();
  const attention = useTaskAttentionEnabled();
  const mobile = isNativeMobileApp();
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
      // Offline push depends on the same permission; re-register right away.
      if (mobile) refreshRemotePush();
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

  const toggleAttention = (kind: AttentionKind, enabled: boolean) => {
    try {
      setAttentionNotificationPref(kind, enabled);
      setStatus(null);
    } catch {
      setStatus("无法保存通知设置，请检查本机存储是否可用。");
    }
  };

  return (
    <section className="settings-section provider-settings" aria-label="任务通知">
      <div>
        <div className="settings-section-title"><Bell size={15} /><span>任务通知</span></div>
        <p className="settings-section-description">{mobile
          ? "在 App 内时，其他会话的更新以顶部横幅加轻震提醒；切到后台后改用系统通知，App 图标角标显示有未读提醒的会话数，打开 App 即清零。正在查看的会话和 10 秒内完成的任务不提醒，不展示原始错误详情。"
          : "仅在 miniQ 窗口未处于焦点时提醒；不展示原始错误详情。设置会保留在这台设备上。"}</p>
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
      {!mobile && <>
      <div className="settings-toggle-row">
        <span>需要审批时提醒</span>
        <Switch checked={attentionPrefs.approval} onChange={(value) => toggleAttention("approval", value)} label="需要审批时提醒" />
      </div>
      <div className="settings-toggle-row">
        <span>需要我回答时提醒</span>
        <Switch checked={attentionPrefs.question} onChange={(value) => toggleAttention("question", value)} label="需要我回答时提醒" />
      </div>
      </>}
      {mobile && mode !== "off" && <label className="remote-access-toggle" htmlFor="task-notification-attention">
        <span>
          <strong>需要我操作时提醒</strong>
          <small>任务等待审批或回答时，优先提醒并震动</small>
        </span>
        <input
          id="task-notification-attention"
          type="checkbox"
          checked={attention}
          onChange={(event) => {
            try {
              setTaskAttentionEnabled(event.target.checked);
              setStatus(null);
            } catch {
              setStatus("无法保存通知设置，请检查本机存储是否可用。");
            }
          }}
        />
      </label>}
      {mobile && mode !== "off" && <RemotePushStatusRow onStatus={setStatus} />}
      {mobile && mode !== "off" && <QuietHoursSetting onStatus={setStatus} />}
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
