import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import { localDateTime, relativeAge } from "../time";
import type { ScheduledTask, ScheduleSpec, Workspace } from "../types";

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

interface SchedulePanelProps {
  client: RpcClient;
  workspaces: Workspace[];
  defaultWorkspaceId: string | null;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}

function useScheduledTasks(client: RpcClient, setStatus: (status: string | null) => void) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const refresh = useCallback(async () => {
    try {
      const result = await client.call<{ tasks: ScheduledTask[] }>("schedule.list");
      setTasks(result.tasks);
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }, [client, setStatus]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (task: ScheduledTask) => {
    try {
      await client.call("schedule.toggle", { id: task.id, enabled: !task.enabled });
      await refresh();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  };

  const remove = async (task: ScheduledTask) => {
    if (!window.confirm(`删除定时任务"${task.name}"?`)) return;
    try {
      await client.call("schedule.delete", { id: task.id });
      await refresh();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  };

  return { tasks, refresh, toggle, remove };
}

function useScheduleForm(
  client: RpcClient,
  defaultWorkspaceId: string | null,
  refresh: () => Promise<void>,
  setStatus: (status: string | null) => void,
) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId ?? "");
  const [schedType, setSchedType] = useState<ScheduleSpec["type"]>("daily");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState(1);
  const [minutes, setMinutes] = useState(60);

  const applyTemplate = (template: Template) => {
    setCreating(true);
    setName(template.name);
    setPrompt(template.prompt);
    setSchedType(template.schedule.type);
    if (template.schedule.type === "daily") setTime(template.schedule.time);
    if (template.schedule.type === "weekly") {
      setTime(template.schedule.time);
      setWeekday(template.schedule.weekday);
    }
    if (template.schedule.type === "interval") setMinutes(template.schedule.minutes);
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
      await client.call("schedule.create", {
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
    } catch (error) {
      setStatus(errorMessage(error));
    }
  };

  return {
    creating,
    setCreating,
    name,
    setName,
    prompt,
    setPrompt,
    workspaceId,
    setWorkspaceId,
    schedType,
    setSchedType,
    time,
    setTime,
    weekday,
    setWeekday,
    minutes,
    setMinutes,
    applyTemplate,
    create,
  };
}

type ScheduleFormModel = ReturnType<typeof useScheduleForm>;

function EmptySchedule(props: {
  onApplyTemplate: (template: Template) => void;
  onCreateCustom: () => void;
}) {
  return (
    <div className="schedule-empty">
      <div className="schedule-empty-icon">◷</div>
      <div className="schedule-empty-title">创建首个定时任务</div>
      <div className="schedule-empty-sub">从模板开始,或从头自定义</div>
      <div className="template-list">
        {TEMPLATES.map((template) => (
          <div
            key={template.key}
            className="template-card"
            onClick={() => props.onApplyTemplate(template)}
          >
            <div className="template-icon">{template.icon}</div>
            <div className="template-text">
              <div className="template-label">{template.label}</div>
              <div className="template-desc">{template.desc}</div>
            </div>
            <span className="badge">{describeSchedule(template.schedule)}</span>
          </div>
        ))}
        <div className="template-card custom" onClick={props.onCreateCustom}>
          <div className="template-icon">＋</div>
          <div className="template-text">
            <div className="template-label">自定义任务</div>
            <div className="template-desc">自己写指令,自选运行时间</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScheduledTaskList(props: {
  tasks: ScheduledTask[];
  workspaces: Workspace[];
  onOpenResult: (sessionId: string) => void;
  onRunNow: (task: ScheduledTask) => void;
  onToggle: (task: ScheduledTask) => void;
  onRemove: (task: ScheduledTask) => void;
}) {
  const workspaceName = (id: string) =>
    props.workspaces.find((workspace) => workspace.id === id)?.name ?? "已删除的项目";
  return (
    <div className="skill-list">
      {props.tasks.map((task) => (
        <div key={task.id} className="skill-row">
          <div className="skill-row-main">
            <span className="tool-name">{task.name}</span>
            <span className={`badge ${task.enabled ? "succeeded" : ""}`}>
              {task.enabled ? describeSchedule(task.schedule) : "已暂停"}
            </span>
            <div className="sub">
              {workspaceName(task.workspaceId)}
              {task.enabled && ` · 下次 ${localDateTime(task.nextRunAt)}`}
              {task.lastRunAt && ` · 上次运行 ${relativeAge(task.lastRunAt)}前`}
            </div>
          </div>
          {task.lastSessionId && (
            <button className="ghost" onClick={() => props.onOpenResult(task.lastSessionId!)}>
              查看结果
            </button>
          )}
          <button className="ghost" onClick={() => props.onRunNow(task)}>
            立即运行
          </button>
          <button className="ghost" onClick={() => props.onToggle(task)}>
            {task.enabled ? "暂停" : "启用"}
          </button>
          <button className="ghost danger" onClick={() => props.onRemove(task)}>
            删除
          </button>
        </div>
      ))}
    </div>
  );
}

function TemplateButtons(props: {
  onApplyTemplate: (template: Template) => void;
  onCreateCustom: () => void;
}) {
  return (
    <div className="schedule-templates" style={{ marginTop: 12 }}>
      {TEMPLATES.map((template) => (
        <button
          key={template.key}
          className="ghost"
          onClick={() => props.onApplyTemplate(template)}
        >
          {template.icon} {template.label}
        </button>
      ))}
      <button className="ghost" onClick={props.onCreateCustom}>
        ＋ 自定义任务
      </button>
    </div>
  );
}

function ScheduleCreateForm(props: { form: ScheduleFormModel; workspaces: Workspace[] }) {
  const { form } = props;
  return (
    <div className="schedule-form">
      <label>
        名称
        <input
          value={form.name}
          onChange={(event) => form.setName(event.target.value)}
          placeholder="每日简报"
        />
      </label>
      <label>
        任务内容(发给 agent 的指令)
        <textarea
          rows={3}
          value={form.prompt}
          onChange={(event) => form.setPrompt(event.target.value)}
          placeholder="例如:总结今天工作区里的变化,输出一份简报"
        />
      </label>
      <label>
        项目
        <select
          value={form.workspaceId}
          onChange={(event) => form.setWorkspaceId(event.target.value)}
        >
          <option value="">选择项目...</option>
          {props.workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
      </label>
      <div className="schedule-when">
        <select
          value={form.schedType}
          onChange={(event) => form.setSchedType(event.target.value as ScheduleSpec["type"])}
        >
          <option value="daily">每天</option>
          <option value="weekly">每周</option>
          <option value="interval">按间隔</option>
        </select>
        {form.schedType === "weekly" && (
          <select
            value={form.weekday}
            onChange={(event) => form.setWeekday(Number(event.target.value))}
          >
            {WEEKDAYS.map((day, index) => (
              <option key={day} value={index + 1}>
                {day}
              </option>
            ))}
          </select>
        )}
        {(form.schedType === "daily" || form.schedType === "weekly") && (
          <input
            type="time"
            value={form.time}
            onChange={(event) => form.setTime(event.target.value)}
          />
        )}
        {form.schedType === "interval" && (
          <select
            value={form.minutes}
            onChange={(event) => form.setMinutes(Number(event.target.value))}
          >
            <option value={15}>每 15 分钟</option>
            <option value={30}>每 30 分钟</option>
            <option value={60}>每 1 小时</option>
            <option value={180}>每 3 小时</option>
            <option value={360}>每 6 小时</option>
          </select>
        )}
      </div>
      <div className="settings-actions">
        <button onClick={form.create}>创建</button>
        <button className="ghost" onClick={() => form.setCreating(false)}>
          取消
        </button>
      </div>
    </div>
  );
}

export function SchedulePanel(props: SchedulePanelProps) {
  const [status, setStatus] = useState<string | null>(null);
  const tasks = useScheduledTasks(props.client, setStatus);
  const form = useScheduleForm(
    props.client,
    props.defaultWorkspaceId,
    tasks.refresh,
    setStatus,
  );

  const runNow = async (task: ScheduledTask) => {
    try {
      const result = await props.client.call<{ sessionId: string }>("schedule.runNow", {
        id: task.id,
      });
      props.onOpenSession(result.sessionId);
      props.onClose();
    } catch (error) {
      setStatus(errorMessage(error));
    }
  };

  const openResult = (sessionId: string) => {
    props.onOpenSession(sessionId);
    props.onClose();
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-header">
          <div className="page-title">已安排</div>
          <div className="page-sub">定时让 agent 在项目里执行任务、生成简报或跟踪更新。</div>
        </div>
        {status && <div className="settings-status">{status}</div>}
        {tasks.tasks.length === 0 && !form.creating && (
          <EmptySchedule
            onApplyTemplate={form.applyTemplate}
            onCreateCustom={() => form.setCreating(true)}
          />
        )}
        <ScheduledTaskList
          tasks={tasks.tasks}
          workspaces={props.workspaces}
          onOpenResult={openResult}
          onRunNow={(task) => void runNow(task)}
          onToggle={(task) => void tasks.toggle(task)}
          onRemove={(task) => void tasks.remove(task)}
        />
        {tasks.tasks.length > 0 && !form.creating && (
          <TemplateButtons
            onApplyTemplate={form.applyTemplate}
            onCreateCustom={() => form.setCreating(true)}
          />
        )}
        {form.creating && <ScheduleCreateForm form={form} workspaces={props.workspaces} />}
      </div>
    </div>
  );
}
