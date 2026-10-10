import { createContext, useContext } from "react";
import type { RpcClient } from "./rpc";
import type { SessionDiff } from "./types";
import type { TimelineTurn } from "./timelineTurns";

/** Tools that checkpoint files before writing (mirrors the daemon executor). */
export const FILE_WRITE_TOOLS = new Set([
  "file_write",
  "file_edit",
  "doc_write",
  "file_patch",
  "notebook_edit",
  "apply_patch",
]);

export interface TurnModifiedFile {
  path: string;
  absolutePath: string;
  /** `modified`: changed after the turn ended; `unverified`: no turn-end record. */
  reason: "modified" | "unverified";
}

export type TurnRevertResult =
  | { reverted: false; modifiedFiles: TurnModifiedFile[] }
  | {
      reverted: true;
      restoredFiles: string[];
      failedFiles: { path: string; error: string }[];
      forced: boolean;
    };

export function fetchTurnDiff(client: RpcClient, sessionId: string, turnId: string) {
  return client.call<SessionDiff>("session.diff", { sessionId, scope: "turn", turnId });
}

export function revertTurn(client: RpcClient, sessionId: string, turnId: string, force: boolean) {
  return client.call<TurnRevertResult>("session.revertTurn", { sessionId, turnId, force });
}

/** Whether a turn may have changed files and deserves a change card. */
export function turnHasFileWrites(turn: TimelineTurn): boolean {
  if ((turn.timing?.summary?.filesChanged ?? 0) > 0) return true;
  return turn.groups.some((group) => group.kind === "tools"
    && group.calls.some((call) => FILE_WRITE_TOOLS.has(call.toolName)));
}

export interface TurnChangesContextValue {
  client: RpcClient;
  sessionId: string;
  busy: boolean;
  /** Changes when files were restored; cards refetch. */
  epoch: number;
  openReview: (turnId: string, path?: string) => void;
  onReverted: () => void;
}

export const TurnChangesContext = createContext<TurnChangesContextValue | null>(null);

export function useTurnChanges() {
  return useContext(TurnChangesContext);
}
