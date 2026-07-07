import { useCallback, useEffect, useState } from "react";
import type { RpcClient } from "../rpc";
import type { ScheduledTask, ScheduleSpec, Workspace } from "../types";
import { localDateTime, relativeAge } from "../time";

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function describeSchedule(spec: ScheduleSpec): string {
  switch (spec.type) {
    case "daily":
      return `每天 ${spec.time}`;
    case "weekly":
      return `每${WEEKDAYS[(spec.weekday ?? 1) - 1] ?? "周"} ${spec.time}`;
    case "interval":
      return spec.minutes % 60 === 0
        ? `每 ${spec.minutes / 60} 小时`
        : `每 ${spec.minutes} 分钟`;
    default:
      return "";
  }
}

interface Template {
  key: string;
  icon: string;
  label: string;
  desc: string;
  name: string;
  prompt: string;
  schedule: ScheduleSpec;
}

const TEMPLATES: Template[] = [
  {
    key: "daily",
    icon: "🔔",
    label: "每日简报",
    desc: "每天早上总结昨日进展和今日重点",
    name: "每日简报",
    prompt:
      "生成今天的工作简报:查看工作区里最近变动的文件和进行中的事项,总结昨天完成了什么、今天值得关注什么,如果需要外部信息可以联网搜索。",
    schedule: { type: "daily", time: "09:00" },
  },
  {
    key: "weekly",
    icon: "📋",
    label: "每周回顾",
    desc: "每周五梳理本周产出,生成周报文档",
    name: "每周回顾",
    prompt:
      "写一份本周回顾:梳理工作区内这一周的产出与变化,总结完成的事项、未完成的事项和下周建议,输出为一份简洁的周报文档。",
    schedule: { type: "weekly", weekday: 5, time: "17:00" },
  },
  {
    key: "monitor",
    icon: "🔎",
    label: "项目监控",
    desc: "定时巡检项目,发现异常及时汇报",
    name: "项目监控",
    prompt:
      "检查项目状态:查看工作区是否有异常(构建失败记录、TODO 堆积、明显错误),发现问题就整理一份简短的问题清单,没有问题则简单确认一切正常。",
    schedule: { type: "interval", minutes: 60 },
  },
];

export function SchedulePanel(props: {
  client: RpcClient;
  workspaces: Workspace[];
  defaultWorkspaceId: string | null;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Create-form state.
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [workspaceId, setWorkspaceId] = useState(props.defaultWorkspaceId ?? "");
  const [schedType, setSchedType] = useState<ScheduleSpec["type"]>("daily");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [minutes, setMinutes] = useState(60);

  const refresh = useCallback(async () => {
    try {
      const res = await props.client.call<{ tasks: ScheduledTask[] }>("schedule.list");
      setTasks(res.tasks);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  }, [props.client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const applyTemplate = (t: Template) => {
    setCreating(true);
    setName(t.name);
    setPrompt(t.prompt);
    setSchedType(t.schedule.type);
    if (t.schedule.type === "daily") setTime(t.schedule.time);
    if (t.schedule.type === "weekly") {
      setTime(t.schedule.time);
      setWeekday(t.schedule.weekday);
    }
    if (t.schedule.type === "interval") setMinutes(t.schedule.minutes);
  };

  const create = async () => {
    if (!name.trim() || !prompt.trim() || !workspaceId) {
      setStatus("请填写名称、任务内容并选择项目");
      return;
    }
    const schedule: ScheduleSpec =
      schedType === "daily"
        ? { type: "daily", time }
        : schedType === "weekly"
          ? { type: "weekly", weekday, time }
          : { type: "interval", minutes };
    try {
      await props.client.call("schedule.create", {
        workspaceId,
        name: name.trim(),
        prompt: prompt.trim(),
        schedule,
      });
      setCreating(false);
      setName("");
      setPrompt("");
      setStatus(null);
      await refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const toggle = async (task: ScheduledTask) => {
    try {
      await props.client.call("schedule.toggle", { id: task.id, enabled: !task.enabled });
      await refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (task: ScheduledTask) => {
    if (!window.confirm(`删除定时任务"${task.name}"?`)) return;
    try {
      await props.client.call("schedule.delete", { id: task.id });
      await refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const runNow = async (task: ScheduledTask) => {
    try {
      const res = await props.client.call<{ sessionId: string }>("schedule.runNow", {
        id: task.id,
      });
      props.onOpenSession(res.sessionId);
      props.onClose();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };

  const wsName = (id: string) =>
    props.workspaces.find((w) => w.id === id)?.name ?? "已删除的项目";

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div className="page-title">已安排</div>
          <div className="page-sub">定时让 agent 在项目里执行任务、生成简报或跟踪更新。</div>
        </div>
        {status && <div className="settings-status">{status}</div>}

        {tasks.length === 0 && !creating && (
          <div className="schedule-empty">
            <div className="schedule-empty-icon">◷</div>
            <div className="schedule-empty-title">创建首个定时任务</div>
            <div className="schedule-empty-sub">从模板开始,或从头自定义</div>
            <div className="template-list">
              {TEMPLATES.map((t) => (
                <div key={t.key} className="template-card" onClick={() => applyTemplate(t)}>
                  <div className="template-icon">{t.icon}</div>
                  <div className="template-text">
                    <div className="template-label">{t.label}</div>
                    <div className="template-desc">{t.desc}</div>
                  </div>
                  <span className="badge">{describeSchedule(t.schedule)}</span>
                </div>
              ))}
              <div className="template-card custom" onClick={() => setCreating(true)}>
                <div className="template-icon">＋</div>
                <div className="template-text">
                  <div className="template-label">自定义任务</div>
                  <div className="template-desc">自己写指令,自选运行时间</div>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="skill-list">
          {tasks.map((task) => (
            <div key={task.id} className="skill-row">
              <div className="skill-row-main">
                <span className="tool-name">{task.name}</span>
                <span className={`badge ${task.enabled ? "succeeded" : ""}`}>
                  {task.enabled ? describeSchedule(task.schedule) : "已暂停"}
                </span>
                <div className="sub">
                  {wsName(task.workspaceId)}
                  {task.enabled && ` · 下次 ${localDateTime(task.nextRunAt)}`}
                  {task.lastRunAt && ` · 上次运行 ${relativeAge(task.lastRunAt)}前`}
                </div>
              </div>
              {task.lastSessionId && (
                <button
                  className="ghost"
                  onClick={() => {
                    props.onOpenSession(task.lastSessionId!);
                    props.onClose();
                  }}
                >
                  查看结果
                </button>
              )}
              <button className="ghost" onClick={() => runNow(task)}>
                立即运行
              </button>
              <button className="ghost" onClick={() => toggle(task)}>
                {task.enabled ? "暂停" : "启用"}
              </button>
              <button className="ghost danger" onClick={() => remove(task)}>
                删除
              </button>
            </div>
          ))}
        </div>

        {tasks.length > 0 && !creating && (
          <div className="schedule-templates" style={{ marginTop: 12 }}>
            {TEMPLATES.map((t) => (
              <button key={t.key} className="ghost" onClick={() => applyTemplate(t)}>
                {t.icon} {t.label}
              </button>
            ))}
            <button className="ghost" onClick={() => setCreating(true)}>
              ＋ 自定义任务
            </button>
          </div>
        )}

        {creating && (
          <div className="schedule-form">
            <label>
              名称
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="每日简报" />
            </label>
            <label>
              任务内容(发给 agent 的指令)
              <textarea
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="例如:总结今天工作区里的变化,输出一份简报"
              />
            </label>
            <label>
              项目
              <select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
                <option value="">选择项目...</option>
                {props.workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="schedule-when">
              <select
                value={schedType}
                onChange={(e) => setSchedType(e.target.value as ScheduleSpec["type"])}
              >
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
                <option value="interval">按间隔</option>
              </select>
              {schedType === "weekly" && (
                <select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i + 1}>
                      {d}
                    </option>
                  ))}
                </select>
              )}
              {(schedType === "daily" || schedType === "weekly") && (
                <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              )}
              {schedType === "interval" && (
                <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
                  <option value={15}>每 15 分钟</option>
                  <option value={30}>每 30 分钟</option>
                  <option value={60}>每 1 小时</option>
                  <option value={180}>每 3 小时</option>
                  <option value={360}>每 6 小时</option>
                </select>
              )}
            </div>
            <div className="settings-actions">
              <button onClick={create}>创建</button>
              <button className="ghost" onClick={() => setCreating(false)}>
                取消
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
