import type { TurnProgress } from "../types";
import { compactDuration } from "../timelineTurns";
import { LiveElapsed } from "./LiveElapsed";
import "./TurnActivityTail.css";

/** An ephemeral end-of-response marker, separate from the turn's status header. */
export function TurnActivityTail({ progress }: { progress?: TurnProgress | null }) {
  // Same clock as the former "current step" indicator, not the whole turn.
  const startedAt = progress?.startedAt;
  const label = progress?.retry ? "Retrying…" : progress?.phase === "finalizing" ? "Finishing…" : "Thinking…";
  return <div className="turn-activity-tail" role="status" aria-live="polite" aria-label="本轮尚未结束">
    <span className="turn-activity-dot" aria-hidden="true">●</span>
    <span>{label}{startedAt && Number.isFinite(Date.parse(startedAt)) && <>
      （<LiveElapsed key={startedAt} startedAt={startedAt} prefix="已运行" format={compactDuration} />）
    </>}</span>
  </div>;
}
