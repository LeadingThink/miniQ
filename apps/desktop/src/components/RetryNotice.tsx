import { useEffect, useState } from "react";
import type { TurnProgress } from "../types";

export function RetryNotice({ progress }: { progress: TurnProgress }) {
  const [now, setNow] = useState(Date.now);
  const retry = progress.retry;
  useEffect(() => {
    if (progress.phase !== "waiting_retry") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [progress.phase, progress.startedAt]);
  if (!retry) return null;
  const remaining = Math.max(
    0,
    Math.ceil((Date.parse(progress.startedAt) + retry.delayMs - now) / 1_000)
  );
  return (
    <span className="retry-notice">
      自动重试 {retry.attempt}/{retry.maxAttempts} ·{" "}
      {progress.phase === "waiting_retry" && remaining > 0
        ? `${remaining} 秒后重试`
        : progress.phase === "receiving_model"
          ? "正在接收响应"
          : progress.phase === "compacting_context"
            ? "正在压缩上下文"
            : "正在恢复请求"}
    </span>
  );
}
