import { CircleAlert } from "lucide-react";
import { errorMessage } from "../errorMessage";
import type { SessionTurnOutcome } from "../types";
import { CopyButton } from "./CopyButton";
import "./TurnFailureNotice.css";

/** The saved failure belongs to the transcript, so dismissing a temporary
 * error or acknowledging its sidebar badge cannot erase the explanation. */
export function TurnFailureNotice({ outcome, onError }: {
  outcome: SessionTurnOutcome;
  onError: (message: string) => void;
}) {
  if (outcome.status !== "failed" || outcome.error === "cancelled") return null;
  const raw = outcome.error;
  const message = raw ? errorMessage(raw) : "当前记录没有保存具体失败原因。";
  return <section className="turn-failure-notice" role="alert" aria-label="本轮执行失败">
    <div className="turn-failure-heading"><CircleAlert size={16} aria-hidden="true" /><strong>执行失败</strong>
      {raw && <CopyButton content={raw} label="复制失败详情" onError={onError} />}
    </div>
    <p className="turn-failure-reason">{message}</p>
    {raw && raw !== message && <details><summary>原始错误详情</summary><pre>{raw}</pre></details>}
  </section>;
}
