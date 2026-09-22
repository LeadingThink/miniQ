import { useEffect, useMemo, useRef, useState } from "react";
import type { RpcClient } from "../rpc";
import type { ScheduleSpec, ScheduledTask, ScheduledTaskMode, Session, Workspace } from "../types";
import { errorMessage } from "../errorMessage";

const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
export interface ScheduleTemplate {
  name: string;
  prompt: string;
  schedule: ScheduleSpec;
}

interface Props {
  client: RpcClient; workspaces: Workspace[]; defaultWorkspaceId: string | null;
  task?: ScheduledTask; template?: ScheduleTemplate;
  onPendingChange: (pending: boolean) => void; onCancel: () => void; onSaved: () => Promise<void>;
}

function initial(task: ScheduledTask | undefined, template: ScheduleTemplate | undefined, defaultWorkspaceId: string | null) {
  const schedule = task?.schedule ?? template?.schedule ?? { type: "daily" as const, time: "09:00" };
  return {
    name: task?.name ?? template?.name ?? "", prompt: task?.prompt ?? template?.prompt ?? "",
    workspaceId: task?.workspaceId ?? defaultWorkspaceId ?? "", schedule,
    mode: task?.mode ?? "newSession" as ScheduledTaskMode,
    targetSessionId: task?.targetSessionId ?? "", memory: task?.memory ?? "",
  };
}

export function ScheduleForm({ client, workspaces, defaultWorkspaceId, task, template, onPendingChange, onCancel, onSaved }: Props) {
  const defaults = useMemo(() => initial(task, template, defaultWorkspaceId), [task, template, defaultWorkspaceId]);
  const [name, setName] = useState(defaults.name), [prompt, setPrompt] = useState(defaults.prompt);
  const [workspaceId, setWorkspaceId] = useState(defaults.workspaceId), [type, setType] = useState(defaults.schedule.type);
  const [time, setTime] = useState("time" in defaults.schedule ? defaults.schedule.time : "09:00");
  const [weekday, setWeekday] = useState("weekday" in defaults.schedule ? defaults.schedule.weekday : 1);
  const [weekdays, setWeekdays] = useState("weekdays" in defaults.schedule ? defaults.schedule.weekdays : [1, 2, 3, 4, 5]);
  const [minutes, setMinutes] = useState("minutes" in defaults.schedule ? defaults.schedule.minutes : 60);
  const [mode, setMode] = useState(defaults.mode), [targetSessionId, setTargetSessionId] = useState(defaults.targetSessionId);
  const [memory, setMemory] = useState(defaults.memory), [sessions, setSessions] = useState<Session[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false), [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null), [sessionRevision, setSessionRevision] = useState(0);
  const saveLock = useRef(false);

  useEffect(() => {
    setName(defaults.name); setPrompt(defaults.prompt); setWorkspaceId(defaults.workspaceId); setType(defaults.schedule.type);
    setTime("time" in defaults.schedule ? defaults.schedule.time : "09:00"); setWeekday("weekday" in defaults.schedule ? defaults.schedule.weekday : 1);
    setWeekdays("weekdays" in defaults.schedule ? defaults.schedule.weekdays : [1, 2, 3, 4, 5]); setMinutes("minutes" in defaults.schedule ? defaults.schedule.minutes : 60);
    setMode(defaults.mode); setTargetSessionId(defaults.targetSessionId); setMemory(defaults.memory); setError(null);
  }, [defaults]);

  useEffect(() => {
    let active = true;
    setSessions([]); setSessionError(null);
    if (mode !== "heartbeat" || !workspaceId) { setLoadingSessions(false); return () => { active = false; }; }
    setLoadingSessions(true);
    void client.call<{ sessions: Session[] }>("session.list", { workspaceId }).then((result) => {
      if (active) setSessions(result.sessions.filter((session) => session.workspaceId === workspaceId && !session.archived && !session.external));
    }).catch((cause) => { if (active) setSessionError(errorMessage(cause)); }).finally(() => { if (active) setLoadingSessions(false); });
    return () => { active = false; };
  }, [client, mode, workspaceId, sessionRevision]);

  const schedule: ScheduleSpec = type === "daily" ? { type, time } : type === "weekly" ? { type, weekday, time } : type === "weekdays" ? { type, weekdays: [...new Set(weekdays)].sort((a, b) => a - b), time } : { type, minutes };
  const save = async () => {
    if (saveLock.current) return;
    if (!name.trim() || !prompt.trim() || !workspaceId) return setError("请填写名称、任务内容并选择项目");
    if (mode === "heartbeat" && (loadingSessions || sessionError || !sessions.some((session) => session.id === targetSessionId))) return setError("请选择要续接的同项目会话");
    if (type === "weekdays" && weekdays.length === 0) return setError("至少选择一个星期几");
    if (type !== "interval" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return setError("请设置有效的执行时间");
    if (type === "interval" && (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080)) return setError("间隔应为 1 至 10080 之间的整数分钟");
    saveLock.current = true;
    setSaving(true); onPendingChange(true); setError(null);
    try {
      await client.call(task ? "schedule.update" : "schedule.create", { ...(task ? { id: task.id } : {}), workspaceId, name: name.trim(), prompt: prompt.trim(), schedule, mode, targetSessionId: mode === "heartbeat" ? targetSessionId : null, memory });
      await onSaved();
    } catch (cause) { setError(errorMessage(cause)); }
    finally { saveLock.current = false; setSaving(false); onPendingChange(false); }
  };
  return <div className="schedule-form" aria-label={task ? "编辑定时任务" : "创建定时任务"}>
    <h2>{task ? "编辑定时任务" : "创建定时任务"}</h2>
    <fieldset disabled={saving} style={{ border: 0, margin: 0, padding: 0, minWidth: 0, display: "contents" }}>
    <label>名称<input value={name} onChange={(e) => setName(e.target.value)} placeholder="每日简报" /></label>
    <label>任务内容<textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label>
    <label>项目<select value={workspaceId} onChange={(e) => { setWorkspaceId(e.target.value); setTargetSessionId(""); setMemory(""); }}><option value="">选择项目...</option>{workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name}</option>)}</select></label>
    <label>执行方式<select value={mode} onChange={(e) => { setMode(e.target.value as ScheduledTaskMode); setTargetSessionId(""); }}><option value="newSession">每次新建会话（推荐）</option><option value="heartbeat">续接已有会话</option></select></label>
    {mode === "heartbeat" && <>
      <label>目标会话<select value={targetSessionId} onChange={(e) => setTargetSessionId(e.target.value)} disabled={loadingSessions}><option value="">{loadingSessions ? "正在加载会话…" : "选择同项目会话…"}</option>{sessions.map((session) => <option value={session.id} key={session.id}>{session.title || "未命名会话"}</option>)}</select></label>
      {sessionError && <div role="alert">{sessionError}<button type="button" className="ghost" onClick={() => setSessionRevision((value) => value + 1)}>重新加载会话</button></div>}
      {!loadingSessions && !sessionError && sessions.length === 0 && <p role="status">该项目暂无可续接会话。请先创建会话，或选择每次新建会话。</p>}
      {!loadingSessions && !sessionError && targetSessionId && !sessions.some((session) => session.id === targetSessionId) && <p role="alert">原目标会话已不可续接，请重新选择。</p>}
    </>}
    <label>任务记忆<textarea rows={3} value={memory} onChange={(e) => setMemory(e.target.value)} placeholder="每次运行附带的长期上下文（可选）" /></label>
    <div className="schedule-when"><select aria-label="运行频率" value={type} onChange={(e) => setType(e.target.value as ScheduleSpec["type"])}><option value="daily">每天</option><option value="weekly">每周</option><option value="weekdays">自选星期</option><option value="interval">按间隔</option></select>
      {type === "weekly" && <select aria-label="星期几" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>{DAYS.map((day, index) => <option value={index + 1} key={day}>{day}</option>)}</select>}
      {type === "weekdays" && <div className="schedule-weekdays">{DAYS.map((day, index) => <label key={day}><input type="checkbox" checked={weekdays.includes(index + 1)} onChange={() => setWeekdays((current) => current.includes(index + 1) ? current.filter((value) => value !== index + 1) : [...current, index + 1])} />{day}</label>)}</div>}
      {(type === "daily" || type === "weekly" || type === "weekdays") && <input aria-label="执行时间" type="time" value={time} onChange={(e) => setTime(e.target.value)} />}
      {type === "interval" && <input aria-label="间隔分钟" type="number" min={1} max={10080} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />}
    </div>
    {error && <div className="settings-status" role="alert">{error}</div>}
    <div className="settings-actions"><button type="button" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : task ? "保存修改" : "创建任务"}</button><button type="button" className="ghost" disabled={saving} onClick={onCancel}>取消</button></div>
    </fieldset>
  </div>;
}
