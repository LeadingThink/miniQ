import { describe, expect, it, vi } from "vitest";
import type { Session, Workspace } from "../../types";
import { companionSessionState, mostRelevantSession, sendCompanionTask, type CompanionRpc } from "./companionTask";

const workspace = { id: "project-a", path: "/authorized/a", name: "A" } as Workspace;
const session = { id: "task-a", workspaceId: workspace.id, title: "Task", status: "idle", updatedAt: "2026-01-01" } as Session;
const draft = { content: " 实现功能\n保留格式 ", workspaceId: workspace.id, sessionId: null };
const rpc = (call: ReturnType<typeof vi.fn>) => ({ call } as CompanionRpc);

describe("local companion tasks", () => {
  it("creates in the explicitly chosen workspace, inherits defaults and sends real message", async () => {
    const call = vi.fn().mockResolvedValueOnce(session).mockResolvedValueOnce({});
    const result = await sendCompanionTask(rpc(call), draft, [workspace], []);
    expect(call.mock.calls).toEqual([
      ["session.create", { workspaceId: workspace.id }],
      ["session.sendMessage", { sessionId: session.id, message: { role: "user", content: draft.content, attachments: [] }, rejectIfBusy: true }],
    ]);
    expect(result).toMatchObject({ sent: true, draft: { content: "", sessionId: session.id } });
  });
  it("preserves the exact failed draft and created session; explicit retry does not create twice", async () => {
    const call = vi.fn().mockResolvedValueOnce(session).mockRejectedValueOnce(new Error("API key missing"));
    const failed = await sendCompanionTask(rpc(call), draft, [workspace], []);
    expect(failed).toMatchObject({ sent: false, error: "API key missing", draft: { content: draft.content, sessionId: session.id } });
    call.mockResolvedValueOnce({});
    expect((await sendCompanionTask(rpc(call), failed.draft, [workspace], [session])).sent).toBe(true);
    expect(call.mock.calls.filter(([method]) => method === "session.create")).toHaveLength(1);
  });
  it("preserves draft on create failure and never sends", async () => {
    const call = vi.fn().mockRejectedValue(new Error("offline"));
    expect(await sendCompanionTask(rpc(call), draft, [workspace], [])).toMatchObject({ sent: false, draft, error: "offline" });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("refuses missing projects, blank text and mismatched/archived/external sessions", async () => {
    const call = vi.fn();
    const variants = [
      { ...draft, workspaceId: "unknown-root" }, { ...draft, content: "  \n " },
      { ...draft, sessionId: "other-project" }, { ...draft, sessionId: "archived" }, { ...draft, sessionId: "external" },
    ];
    const sessions = [
      { ...session, id: "other-project", workspaceId: "b" },
      { ...session, id: "archived", archived: true },
      { ...session, id: "external", external: {} },
    ] as Session[];
    for (const variant of variants) expect((await sendCompanionTask(rpc(call), variant, [workspace], sessions)).sent).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });
  it("never sends to a wrongly scoped create response", async () => {
    const call = vi.fn().mockResolvedValue({ ...session, workspaceId: "b" });
    expect((await sendCompanionTask(rpc(call), draft, [workspace], [])).sent).toBe(false);
    expect(call).toHaveBeenCalledTimes(1);
  });
});

it("maps all daemon states and gives attention priority without mutating catalogs", () => {
  expect(companionSessionState()).toBe("idle");
  for (const [status, state] of [["running", "running"], ["cancelling", "running"], ["waiting_approval", "needs_input"], ["failed", "failed"], ["idle", "idle"]] as const) {
    expect(companionSessionState({ ...session, status })).toBe(state);
  }
  expect(companionSessionState({ ...session, turnCount: 1 })).toBe("ready");
  expect(companionSessionState(session, true)).toBe("needs_input");
  const sessions = [{ ...session, id: "run", status: "running" }, { ...session, id: "approve", status: "waiting_approval" }] as Session[];
  expect(mostRelevantSession(sessions)?.id).toBe("approve");
  expect(sessions[0].id).toBe("run");
});
