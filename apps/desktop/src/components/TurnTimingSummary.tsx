import type { TurnTiming } from "../types";
import { conversationTimestamp, formatDuration } from "../time";
import { LiveElapsed } from "./LiveElapsed";
import "./MessageTime.css";

export function TurnTimingSummary({ timing, active = false }: { timing: TurnTiming; active?: boolean }) {
  'use no memo';
  const start = conversationTimestamp(timing.startedAt);
  if (!start) return null;
  const running = timing.status === "running" && active;
  const elapsedMs = timing.summary?.durationMs ?? timing.elapsedMs ?? (timing.completedAt
    ? Date.parse(timing.completedAt) - Date.parse(timing.startedAt) : undefined);
  const duration = elapsedMs === undefined ? null : formatDuration(elapsedMs);
  const end = timing.completedAt ? conversationTimestamp(timing.completedAt) : null;
  const label = timing.status === "completed" ? "总运行时间"
    : timing.status === "failed" ? "执行失败 · 总运行时间"
      : timing.status === "cancelled" ? "已停止 · 总运行时间" : "已中断 · 总运行时间";
  return <details className="turn-timing">
    <summary>
      {running ? <LiveElapsed startedAt={timing.startedAt} prefix="正在执行 · 总运行时间" />
        : duration ? `${label} ${duration}` : "用时记录不完整"}
    </summary>
    <p>开始：<time dateTime={timing.startedAt}>{start.full}</time></p>
    {end && <p>结束：<time dateTime={timing.completedAt}>{end.full}</time></p>}
    <p>{duration || running
      ? "统计本次任务从开始执行到结束的时间，包含模型、工具、自动重试及等待确认，不含排队时间；并行操作不重复相加。"
      : "执行已中断，缺少可靠的结束时间，未估算用时。"}</p>
  </details>;
}
