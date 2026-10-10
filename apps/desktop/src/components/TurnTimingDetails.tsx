import type { TurnTiming } from "../types";
import { conversationTimestamp } from "../time";
import "./MessageTime.css";

const MEASUREMENT_NOTE = "用时统计本次任务从开始执行到结束的时间，包含模型、工具、自动重试及等待确认，不含排队时间；并行操作不重复相加。";

/** One compact line inside an expanded execution fold. The fold header owns
 * the duration; this line only adds the wall-clock start and end. */
export function TurnTimingDetails({ timing }: { timing: TurnTiming }) {
  const start = conversationTimestamp(timing.startedAt);
  if (!start) return null;
  const end = timing.completedAt ? conversationTimestamp(timing.completedAt) : null;
  const interrupted = !end && timing.status !== "running";
  return (
    <p className="turn-timing-details" title={interrupted ? "执行已中断，缺少可靠的结束时间，未估算用时。" : MEASUREMENT_NOTE}>
      开始 <time dateTime={timing.startedAt} title={start.full}>{start.label}</time>
      {end && <> · 结束 <time dateTime={timing.completedAt} title={end.full}>{end.label}</time></>}
      {interrupted && " · 已中断，未记录结束时间"}
    </p>
  );
}
