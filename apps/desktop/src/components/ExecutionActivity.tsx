import {
  Check,
  ChevronRight,
  CircleSlash,
  CircleX,
  LoaderCircle,
  RotateCcw,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { PlanTask, ToolCall, TurnProgress } from "../types";

interface ToolAction {
  running: string;
  finished: string;
}

const TOOL_ACTIONS: Record<string, ToolAction> = {
  file_read: { running: "正在读取文件", finished: "读取了文件" },
  file_list: { running: "正在查看目录", finished: "查看了目录" },
  file_glob: { running: "正在查找文件", finished: "查找了文件" },
  file_grep: { running: "正在搜索代码", finished: "搜索了代码" },
  file_write: { running: "正在创建文件", finished: "创建了文件" },
  file_edit: { running: "正在修改文件", finished: "修改了文件" },
  file_patch: { running: "正在应用代码补丁", finished: "应用了代码补丁" },
  shell_run: { running: "正在运行命令", finished: "运行了命令" },
  git_status: { running: "正在检查 Git 状态", finished: "检查了 Git 状态" },
  git_diff: { running: "正在查看代码改动", finished: "查看了代码改动" },
  web_search: { running: "正在搜索网页", finished: "搜索了网页" },
  web_fetch: { running: "正在读取网页", finished: "读取了网页" },
  http_request: { running: "正在请求接口", finished: "请求了接口" },
  browser_automation: { running: "正在操作浏览器", finished: "操作了浏览器" },
  doc_read: { running: "正在读取文档", finished: "读取了文档" },
  doc_write: { running: "正在生成文档", finished: "生成了文档" },
  memory_search: { running: "正在检索记忆", finished: "检索了记忆" },
  memory_write: { running: "正在保存记忆", finished: "保存了记忆" },
  skill_read: { running: "正在加载技能", finished: "加载了技能" },
  ask_user: { running: "正在准备确认问题", finished: "确认了下一步" },
};

export function toolActionLabel(toolName: string, running: boolean): string {
  const action = TOOL_ACTIONS[toolName];
  if (action) return running ? action.running : action.finished;
  return running ? "正在执行下一步" : "完成了一个步骤";
}

/** One-line human summary of the most relevant tool input. */
export function toolInputSummary(call: ToolCall): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const keys = ["path", "command", "url", "query", "pattern", "name", "prompt"];
  for (const key of keys) {
    if (typeof input[key] === "string") return input[key];
  }
  return "";
}

export function toolDuration(call: ToolCall): string | null {
  if (!call.completedAt) return null;
  const elapsed = new Date(call.completedAt).getTime() - new Date(call.createdAt).getTime();
  return formatDuration(elapsed);
}

function formatDuration(elapsed: number): string | null {
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  if (elapsed < 1_000) return "<1 秒";
  const seconds = Math.round(elapsed / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分`;
}

function LiveElapsed({
  startedAt,
  className,
  prefix,
}: {
  startedAt: string;
  className: string;
  prefix?: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const duration = formatDuration(now - new Date(startedAt).getTime());
  if (!duration) return null;
  return <span className={className}>{prefix ? `${prefix} ${duration}` : duration}</span>;
}

function formatPayload(payload: unknown): string {
  return typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

function statusText(call: ToolCall): string | null {
  switch (call.status) {
    case "waiting_approval":
      return "等待确认";
    case "failed":
      return "失败";
    case "rejected":
      return "已拒绝";
    case "cancelled":
      return "已取消";
    default:
      return null;
  }
}

export function ToolStep(props: {
  call: ToolCall;
  onRollback: (checkpointId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { call } = props;
  const running = call.status === "running" || call.status === "waiting_approval";
  const checkpointId =
    call.output && typeof call.output === "object"
      ? ((call.output as Record<string, unknown>).checkpointId as string | undefined)
      : undefined;
  const summary = toolInputSummary(call);
  const duration = toolDuration(call);
  const state = statusText(call);

  return (
    <div className={`tool-step ${call.status}`} aria-live={running ? "polite" : undefined}>
      <div className="tool-step-head">
        <button
          type="button"
          className="tool-step-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="tool-step-marker" aria-hidden="true">
            {running ? (
              <LoaderCircle className="activity-spinner" size={15} />
            ) : call.status === "succeeded" ? (
              <Check size={14} />
            ) : call.status === "failed" ? (
              <CircleX size={14} />
            ) : (
              <CircleSlash size={14} />
            )}
          </span>
          <span className="tool-action">{toolActionLabel(call.toolName, running)}</span>
          {summary && <span className="tool-summary">{summary}</span>}
          {state && <span className={`tool-step-state ${call.status}`}>{state}</span>}
          {running ? (
            <LiveElapsed startedAt={call.createdAt} className="tool-duration" />
          ) : (
            duration && <span className="tool-duration">{duration}</span>
          )}
          <ChevronRight className={`chevron ${open ? "open" : ""}`} size={14} />
        </button>
        {checkpointId && call.status === "succeeded" && (
          <button
            type="button"
            className="ghost tool-rollback"
            title="回滚这一步"
            onClick={() => props.onRollback(checkpointId)}
          >
            <RotateCcw size={12} />
            回滚
          </button>
        )}
      </div>
      {open && (
        <div className="tool-step-body">
          <div>
            <span>输入</span>
            <pre>{formatPayload(call.input)}</pre>
          </div>
          {call.output !== undefined && call.output !== null && (
            <div>
              <span>结果</span>
              <pre>{formatPayload(call.output)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function PlanProgress({ plan }: { plan: PlanTask[] }) {
  if (plan.length === 0) return null;
  const done = plan.filter((task) => task.status === "completed").length;

  return (
    <section className="execution-plan" aria-label={`任务进度 ${done}/${plan.length}`}>
      <div className="execution-plan-head">
        <strong>{done === plan.length ? "任务步骤已完成" : "任务进度"}</strong>
        <span>{done}/{plan.length}</span>
      </div>
      <ol>
        {plan.map((task, index) => (
          <li key={`${index}-${task.content}`} className={task.status}>
            <span className="plan-step-marker" aria-hidden="true">
              {task.status === "completed" ? (
                <Check size={12} />
              ) : task.status === "in_progress" ? (
                <LoaderCircle className="activity-spinner" size={13} />
              ) : (
                <span />
              )}
            </span>
            <span>{task.content}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function turnProgressLabel(progress: TurnProgress | null): string {
  if (!progress) return "正在分析并准备下一步";
  switch (progress.phase) {
    case "preparing_context":
      return "正在读取会话和工作区";
    case "compacting_context":
      return "正在整理较长的会话上下文";
    case "requesting_model":
      return progress.modelStep === 1
        ? "正在请求模型分析任务"
        : "正在将执行结果交给模型";
    case "receiving_model":
      return "模型正在生成响应";
    case "finalizing":
      return "正在保存并整理结果";
  }
}

export function ExecutionPrelude({
  plan,
  progress,
}: {
  plan: PlanTask[];
  progress: TurnProgress | null;
}) {
  const activeTask = plan.find((task) => task.status === "in_progress");
  return (
    <div className="execution-prelude" role="status" aria-live="polite">
      <LoaderCircle className="activity-spinner" size={15} />
      <div>
        <strong>{turnProgressLabel(progress)}</strong>
        {progress?.modelStep && (
          <span className="execution-phase-meta">
            第 {progress.modelStep} 轮
            <LiveElapsed
              startedAt={progress.startedAt}
              className="execution-elapsed"
              prefix="已等待"
            />
          </span>
        )}
        {progress && !progress.modelStep && (
          <LiveElapsed
            startedAt={progress.startedAt}
            className="execution-elapsed"
            prefix="已等待"
          />
        )}
        {activeTask && <span>{activeTask.content}</span>}
      </div>
    </div>
  );
}
