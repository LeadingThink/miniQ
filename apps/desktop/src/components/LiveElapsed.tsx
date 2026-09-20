import { useEffect, useState } from "react";
import { formatDuration } from "../time";

/** Mount only for active work. Never leave a ticking clock on completed history. */
export function LiveElapsed({ startedAt, className, prefix }: {
  startedAt: string; className?: string; prefix?: string;
}) {
  const [elapsed, setElapsed] = useState(() => Math.max(0, Date.now() - Date.parse(startedAt)));
  useEffect(() => {
    const initial = Math.max(0, Date.now() - Date.parse(startedAt));
    const clock = performance.now();
    const update = () => setElapsed(initial + performance.now() - clock);
    let timer: ReturnType<typeof setInterval> | undefined;
    const visibility = () => {
      clearInterval(timer);
      if (document.visibilityState !== "hidden") {
        update();
        timer = setInterval(update, 1_000);
      }
    };
    visibility();
    document.addEventListener("visibilitychange", visibility);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", visibility); };
  }, [startedAt]);
  const duration = formatDuration(elapsed);
  if (!duration) return null;
  return <span className={className} style={{ fontVariantNumeric: "tabular-nums" }} aria-live="off">
    {prefix ? `${prefix} ${duration}` : duration}
  </span>;
}
