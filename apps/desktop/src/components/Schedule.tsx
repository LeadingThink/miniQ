import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";
import { localDateTime, relativeAge } from "../time";
import type { ScheduledTask, ScheduleSpec, Workspace } from "../types";
import { ScheduleForm, type ScheduleTemplate } from "./ScheduleForm";

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export function describeSchedule(spec: ScheduleSpec): string {
  switch (spec.type) {
    case "daily": return `每天 ${spec.time}`;
    case "weekly": return `每${WEEKDAYS[spec.weekday - 1]} ${spec.time}`;
    case "weekdays": return `${[...new Set(spec.weekdays)].sort((a, b) => a - b).map((day) => WEEKDAYS[day - 1]).join("、")} ${spec.time}`;
    case "interval": return spec.minutes % 60 === 0 ? `每 ${spec.minutes / 60} 小时` : `每 ${spec.minutes} 分钟`;
  }
}

const TEMPLATES: (ScheduleTemplate & { key: string; icon: string; desc: string })[] = [
  { key: "daily", icon: "🔔", name: "每日简报", desc: "每天早上总结昨日进展和今日重点",
    prompt: "生成今天的工作简报：查看工作区里最近变动的文件和进行中的事项，总结昨天完成了什么、今天值得关注什么，如果需要外部信息可以联网搜索。",
    schedule: { type: "daily", time: "09:00" } },
  { key: "weekly", icon: "📋", name: "每周回顾", desc: "每周五梳理本周产出，生成周报文档",
    prompt: "写一份本周回顾：梳理工作区内这一周的产出与变化，总结完成的事项、未完成的事项和下周建议，输出为一份简洁的周报文档。",
    schedule: { type: "weekly", weekday: 5, time: "17:00" } },
  { key: "monitor", icon: "🔎", name: "项目监控", desc: "定时巡检项目，发现异常及时汇报",
    prompt: "检查项目状态：查看工作区是否有异常（构建失败记录、TODO 堆积、明显错误），发现问题就整理一份简短的问题清单，没有问题则简单确认一切正常。",
    schedule: { type: "interval", minutes: 60 } },
];

interface SchedulePanelProps {
  client: RpcClient;
  workspaces: Workspace[];
  defaultWorkspaceId: string | null;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}

function useScheduledTasks(client: RpcClient) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const actionLock = useRef(false);
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++epoch.current;
    setLoading(true);
    try {
      const result = await client.call<{ tasks: ScheduledTask[] }>("schedule.list");
      if (request !== epoch.current) return;
      setTasks(result.tasks);
      setError(null);
    } catch (cause) {
      if (request === epoch.current) setError(errorMessage(cause));
    } finally {
      if (request === epoch.current) setLoading(false);
    }
  }, [client]);
  useEffect(() => {
    setTasks([]);
    void refresh();
    return () => { epoch.current++; };
  }, [refresh]);

  const act = async (id: string, operation: () => Promise<void>) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setPending(id);
    setError(null);
    try { await operation(); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { actionLock.current = false; setPending(null); }
  };
  return { tasks, loading, error, pending, refresh, act };
}

function TemplateButtons({ empty, onCreate }: { empty: boolean; onCreate: (template?: ScheduleTemplate) => void }) {
  return <div className={empty ? "schedule-empty" : "schedule-templates"}>
    {empty && <><div className="schedule-empty-icon">◷</div><div className="schedule-empty-title">创建首个定时任务</div><div className="schedule-empty-sub">从模板开始，或从头自定义</div></>}
    <div className={empty ? "template-list" : "schedule-templates"}>
      {TEMPLATES.map((template) => <button key={template.key} type="button" className={empty ? "template-card" : "ghost"} onClick={() => onCreate(template)}>
        <span className="template-icon">{template.icon}</span>
        <span className="template-text"><span className="template-label">{template.name}</span>{empty && <span className="template-desc">{template.desc}</span>}</span>
        {empty && <span className="badge">{describeSchedule(template.schedule)}</span>}
      </button>)}
      <button type="button" className={empty ? "template-card custom" : "ghost"} onClick={() => onCreate()}>＋ 自定义任务</button>
    </div>
  </div>;
}

function ScheduledTaskList(props: {
  tasks: ScheduledTask[]; workspaces: Workspace[]; pending: boolean;
  onOpenResult: (sessionId: string) => void;
  onRunNow: (task: ScheduledTask) => void; onToggle: (task: ScheduledTask) => void;
  onRemove: (task: ScheduledTask) => void; onEdit: (task: ScheduledTask) => void;
}) {
  return <div className="skill-list">{props.tasks.map((task) => <div key={task.id} className="skill-row" role="group" aria-label={task.name}>
    <div className="skill-row-main">
      <span className="tool-name">{task.name}</span>
      <span className={`badge ${task.enabled ? "succeeded" : ""}`}>{task.enabled ? describeSchedule(task.schedule) : "已暂停"} · {task.mode === "heartbeat" ? "续接会话" : "新会话"}</span>
      <div className="sub">{props.workspaces.find((workspace) => workspace.id === task.workspaceId)?.name ?? "已删除的项目"}{task.enabled && ` · 下次 ${localDateTime(task.nextRunAt)}`}{task.lastRunAt && ` · 上次运行 ${relativeAge(task.lastRunAt)}前`}</div>
    </div>
    {task.lastSessionId && <button type="button" className="ghost" onClick={() => props.onOpenResult(task.lastSessionId!)}>查看结果</button>}
    <button type="button" className="ghost" disabled={props.pending} onClick={() => props.onRunNow(task)}>立即运行</button>
    <button type="button" className="ghost" disabled={props.pending} onClick={() => props.onEdit(task)}>编辑</button>
    <button type="button" className="ghost" disabled={props.pending} onClick={() => props.onToggle(task)}>{task.enabled ? "暂停" : "启用"}</button>
    <button type="button" className="ghost danger" disabled={props.pending} onClick={() => props.onRemove(task)}>删除</button>
  </div>)}</div>;
}

export function SchedulePanel(props: SchedulePanelProps) {
  const tasks = useScheduledTasks(props.client);
  const [editor, setEditor] = useState<{ revision: number; task?: ScheduledTask; template?: ScheduleTemplate } | null>(null);
  const [saving, setSaving] = useState(false);
  const revision = useRef(0);
  const openResult = (sessionId: string) => { props.onOpenSession(sessionId); props.onClose(); };
  const openEditor = (task?: ScheduledTask, template?: ScheduleTemplate) => setEditor({ revision: ++revision.current, task, template });
  const toggle = (task: ScheduledTask) => tasks.act(task.id, async () => {
    await props.client.call("schedule.toggle", { id: task.id, enabled: !task.enabled });
    await tasks.refresh();
  });
  const remove = (task: ScheduledTask) => {
    if (!window.confirm(`删除定时任务“${task.name}”？`)) return;
    void tasks.act(task.id, async () => {
      await props.client.call("schedule.delete", { id: task.id });
      if (editor?.task?.id === task.id) setEditor(null);
      await tasks.refresh();
    });
  };
  const runNow = (task: ScheduledTask) => tasks.act(task.id, async () => {
    const result = await props.client.call<{ sessionId: string }>("schedule.runNow", { id: task.id });
    openResult(result.sessionId);
  });
  return <div className="page"><div className="page-inner">
    <div className="page-header"><div className="page-title">已安排</div><div className="page-sub">定时生成新结果，或持续跟进同一会话。任务记忆会在每次运行时提供给 agent。</div></div>
    {tasks.loading && <div role="status">正在读取定时任务</div>}
    {tasks.error && <div className="settings-status" role="alert">{tasks.error}<button type="button" className="ghost" disabled={tasks.loading} onClick={() => void tasks.refresh()}>重新加载</button></div>}
    <ScheduledTaskList tasks={tasks.tasks} workspaces={props.workspaces} pending={saving || tasks.pending !== null}
      onOpenResult={openResult} onRunNow={(task) => void runNow(task)} onToggle={(task) => void toggle(task)} onRemove={remove} onEdit={(task) => openEditor(task)} />
    {!editor && !tasks.loading && <TemplateButtons empty={tasks.tasks.length === 0} onCreate={(template) => openEditor(undefined, template)} />}
    {editor && <ScheduleForm key={editor.revision} client={props.client} workspaces={props.workspaces}
      defaultWorkspaceId={props.defaultWorkspaceId} task={editor.task} template={editor.template}
      onPendingChange={setSaving} onCancel={() => setEditor(null)}
      onSaved={async () => { setEditor(null); await tasks.refresh(); }} />}
  </div></div>;
}
