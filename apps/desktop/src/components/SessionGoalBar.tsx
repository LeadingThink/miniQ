import { CirclePause, Play, Target, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { SessionGoal, SessionGoalStatus } from "../types";
import type { RpcClient } from "../rpc";

export interface SessionGoalBarProps {
  client?: RpcClient;
  sessionId?: string;
  goal?: SessionGoal | null;
  onPauseTurn: () => void | Promise<void>;
  onResumeTurn: () => void | Promise<void>;
  onCancelTurn: () => void | Promise<void>;
  onError: (message: string) => void;
}

export function SessionGoalBar(props: SessionGoalBarProps) {
  const [busy, setBusy] = useState(false);
  const [savedGoal, setSavedGoal] = useState<SessionGoal | null>(null);
  const currentGoal = savedGoal ?? props.goal ?? null;

  useEffect(() => {
    setSavedGoal((previous) => {
      if (!props.goal) return null;
      if (
        previous &&
        previous.sessionId === props.goal.sessionId &&
        previous.updatedAt > props.goal.updatedAt
      ) {
        return previous;
      }
      return props.goal;
    });
  }, [props.goal]);

  const updateGoalStatus = async (status: SessionGoalStatus) => {
    return props.client!.call<SessionGoal>("session.goal.update", {
      sessionId: props.sessionId,
      goal: currentGoal!.goal,
      status,
      tokenBudget: currentGoal!.tokenBudget,
    });
  };

  const changeGoalState = async (
    action: "pause" | "resume" | "cancel",
  ) => {
    if (!props.client || !props.sessionId || !currentGoal || busy) return;
    setBusy(true);
    try {
      const status: SessionGoalStatus = action === "pause"
        ? "paused"
        : action === "resume"
          ? "active"
          : "cancelled";
      let saved: SessionGoal;
      if (action === "resume") {
        await props.onResumeTurn();
        saved = await updateGoalStatus(status);
      } else {
        if (action === "pause") await props.onPauseTurn();
        else await props.onCancelTurn();
        saved = await updateGoalStatus(status);
      }
      setSavedGoal(saved);
    } catch (cause) {
      props.onError(
        `${action === "pause" ? "暂停" : action === "resume" ? "继续" : "取消"}目标失败: ${String(cause)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  if (!currentGoal) return null;

  const statusLabel =
    currentGoal.status === "active"
      ? "执行中"
      : currentGoal.status === "paused"
        ? "已暂停"
        : currentGoal.status === "cancelled"
          ? "已取消"
          : "已完成";

  return (
    <div className="session-goal-card" data-testid="session-goal">
      <div className="session-goal-content">
        <div className="session-goal-summary">
          <Target size={14} aria-hidden="true" />
          <span className="session-goal-label">{statusLabel}</span>
          <span className="session-goal-text">{currentGoal.goal}</span>
        </div>
        {(currentGoal.status === "active" || currentGoal.status === "paused") && (
          <div className="session-goal-actions">
            {currentGoal.status === "active" ? (
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => void changeGoalState("pause")}
                title="暂停目标"
              >
                <CirclePause size={14} aria-hidden="true" />
                <span>暂停</span>
              </button>
            ) : (
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => void changeGoalState("resume")}
                title="继续目标"
              >
                <Play size={14} aria-hidden="true" />
                <span>继续</span>
              </button>
            )}
            <button
              type="button"
              className="ghost session-goal-cancel"
              disabled={busy}
              onClick={() => void changeGoalState("cancel")}
              title="取消目标"
            >
              <X size={14} aria-hidden="true" />
              <span>取消</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}