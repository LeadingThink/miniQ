import type { SessionStatus } from "./types";

const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  idle: "空闲",
  running: "执行中",
  waiting_approval: "等待确认",
  cancelling: "正在停止",
  failed: "执行失败",
};

export function sessionStatusLabel(status: SessionStatus): string {
  return SESSION_STATUS_LABELS[status];
}

export function isSessionRunning(status: SessionStatus): boolean {
  return status === "running" || status === "waiting_approval" || status === "cancelling";
}

export function isSessionTerminal(status: SessionStatus): boolean {
  return status === "idle" || status === "failed";
}
