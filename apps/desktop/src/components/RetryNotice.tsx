import { useEffect, useState } from "react";
import type { TurnProgress } from "../types";

export function RetryNotice({ progress }: { progress: TurnProgress }) {
  const [now, setNow] = useState(Date.now);
  const retry = progress.retry;
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!retry) return null;
  const remaining = Math.max(
    0,
    Math.ceil((Date.parse(progress.startedAt) + retry.delayMs - now) / 1_000)
  );
  return (
    <span className="retry-notice">
      自动重试 {retry.attempt}/{retry.maxAttempts} ·{" "}
      {remaining > 0 ? `${remaining} 秒后重试` : "正在恢复请求"}
    </span>
  );
}
