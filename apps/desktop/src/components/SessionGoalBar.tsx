import { CirclePause, Play, Target, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  /** Newest user message time. A finished goal stops showing once a later turn starts. */
  latestUserMessageAt?: string;
}

export function SessionGoalBar(props: SessionGoalBarProps) {
  const [pendingAction, setPendingAction] = useState<{ id: number; sessionId: string } | null>(null);
  const [savedGoal, setSavedGoal] = useState<SessionGoal | null>(null);
  const nextActionId = useRef(0);
  const currentGoal =
    (savedGoal?.sessionId === props.sessionId ? savedGoal : null) ??
    (props.goal?.sessionId === props.sessionId ? props.goal : null);
  const currentGoalRef = useRef(currentGoal);
  const sessionIdRef = useRef(props.sessionId);
  currentGoalRef.current = currentGoal;
  sessionIdRef.current = props.sessionId;

  useEffect(() => {
    setSavedGoal((previous) => {
      if (!props.sessionId) return null;
      if (!props.goal || props.goal.sessionId !== props.sessionId) {
        return previous?.sessionId === props.sessionId ? previous : null;
      }
      if (
        previous &&
        previous.sessionId === props.goal.sessionId &&
        previous.updatedAt > props.goal.updatedAt
      ) {
        return previous;
      }
      return props.goal;
    });
  }, [props.goal, props.sessionId]);

  const updateGoalStatus = async (
    sessionId: string,
    goal: SessionGoal,
    status: SessionGoalStatus,
  ) => {
    return props.client!.call<SessionGoal>("session.goal.update", {
      sessionId,
      goal: goal.goal,
      status,
      tokenBudget: goal.tokenBudget,
    });
  };

  const changeGoalState = async (
    action: "pause" | "resume" | "cancel",
  ) => {
    const sessionId = props.sessionId;
    const goal = currentGoal;
    if (!props.client || !sessionId || !goal || pendingAction?.sessionId === sessionId) return;
    const actionId = ++nextActionId.current;
    setPendingAction({ id: actionId, sessionId });
    try {
      const status: SessionGoalStatus = action === "pause"
        ? "paused"
        : action === "resume"
          ? "active"
          : "cancelled";
      let saved: SessionGoal;
      if (action === "resume") {
        await props.onResumeTurn();
        saved = await updateGoalStatus(sessionId, goal, status);
      } else {
        if (action === "pause") await props.onPauseTurn();
        else await props.onCancelTurn();
        saved = await updateGoalStatus(sessionId, goal, status);
      }
      if (
        sessionIdRef.current === sessionId &&
        currentGoalRef.current?.sessionId === goal.sessionId &&
        currentGoalRef.current?.updatedAt === goal.updatedAt &&
        currentGoalRef.current?.goal === goal.goal
      ) {
        setSavedGoal(saved);
      }
    } catch (cause) {
      if (sessionIdRef.current === sessionId) {
        props.onError(
          `${action === "pause" ? "暂停" : action === "resume" ? "继续" : "取消"}目标失败: ${String(cause)}`,
        );
      }
    } finally {
      setPendingAction((pending) => pending?.id === actionId ? null : pending);
    }
  };

  if (!currentGoal) return null;
  const finished = currentGoal.status === "cancelled" || currentGoal.status === "completed";
  if (finished && props.latestUserMessageAt
    && Date.parse(props.latestUserMessageAt) > Date.parse(currentGoal.updatedAt)) return null;

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
                disabled={!props.client || !props.sessionId || pendingAction?.sessionId === props.sessionId}
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
                disabled={!props.client || !props.sessionId || pendingAction?.sessionId === props.sessionId}
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
              disabled={!props.client || !props.sessionId || pendingAction?.sessionId === props.sessionId}
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
