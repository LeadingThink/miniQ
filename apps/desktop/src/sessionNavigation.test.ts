import { expect, it } from "vitest";
import type { Session, Workspace } from "./types";
import {
  EMPTY_HISTORY,
  moveHistory,
  nextAttentionSession,
  recentSession,
  sidebarSessionOrder,
  stepSession,
  visitSession,
} from "./sessionNavigation";

const ws = (id: string): Workspace => ({ id, path: `/${id}`, additionalPaths: [], name: id, createdAt: "", updatedAt: "" });
const session = (id: string, workspaceId: string, extra: Partial<Session> = {}): Session => ({
  id, workspaceId, workingDirectory: `/${workspaceId}`, title: id, status: "idle", pinned: false, archived: false,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...extra,
} as Session);

it("orders sessions like the sidebar and skips archived ones", () => {
  const order = sidebarSessionOrder(
    [ws("w1"), ws("w2")],
    [session("b", "w2"), session("a", "w1"), session("z", "w1", { archived: true })],
  );
  expect(order).toEqual(["a", "b"]);
});

it("steps with wrap-around", () => {
  expect(stepSession(["a", "b", "c"], "c", 1)).toBe("a");
  expect(stepSession(["a", "b", "c"], "a", -1)).toBe("c");
  expect(stepSession(["a", "b"], null, 1)).toBe("a");
  expect(stepSession(["a"], "a", 1)).toBeNull();
  expect(stepSession([], null, 1)).toBeNull();
});

it("finds the next session needing attention after the current one", () => {
  const sessions = [session("a", "w"), session("b", "w", { status: "waiting_approval" }), session("c", "w")];
  expect(nextAttentionSession(["a", "b", "c"], "b", sessions, new Set(["a"]))).toBe("a");
  expect(nextAttentionSession(["a", "b", "c"], "a", sessions, new Set())).toBe("b");
  expect(nextAttentionSession(["a", "c"], "a", sessions, new Set())).toBeNull();
});

it("tracks back/forward history and MRU", () => {
  let history = ["a", "b", "c"].reduce(visitSession, EMPTY_HISTORY);
  expect(history.mru).toEqual(["c", "b", "a"]);
  const back = moveHistory(history, -1)!;
  expect(back.target).toBe("b");
  history = visitSession(back.history, "b");
  expect(history.entries).toEqual(["a", "b", "c"]);
  expect(moveHistory(history, 1)!.target).toBe("c");
  expect(moveHistory(history, -1, (id) => id !== "a")).toBeNull();
  history = visitSession(history, "d");
  expect(history.entries).toEqual(["a", "b", "d"]);
  expect(recentSession(history, "d", 1)).toBe("b");
  expect(recentSession(history, "d", -1)).toBe("a");
  expect(recentSession(EMPTY_HISTORY, null, 1)).toBeNull();
});
