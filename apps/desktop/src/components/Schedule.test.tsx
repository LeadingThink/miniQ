// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import type { ScheduledTask, Session, Workspace } from "../types";
import { describeSchedule, SchedulePanel } from "./Schedule";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const workspaces: Workspace[] = ["one", "two"].map((id) => ({
  id, name: `项目 ${id}`, path: `/${id}`, additionalPaths: [],
  createdAt: "2026-09-22T00:00:00Z", updatedAt: "2026-09-22T00:00:00Z",
}));
const task: ScheduledTask = {
  id: "scheduled", workspaceId: "one", name: "持续跟进", prompt: "检查并汇报",
  mode: "heartbeat", targetSessionId: "target", memory: "已有记忆",
  schedule: { type: "weekdays", weekdays: [1, 3, 5], time: "04:30" },
  enabled: true, nextRunAt: "2026-09-23T04:30:00Z", lastRunAt: null,
  lastSessionId: null, createdAt: "2026-09-22T00:00:00Z",
};
function session(id: string, patch: Partial<Session> = {}): Session {
  return { id, workspaceId: "one", title: `会话 ${id}`, workingDirectory: "/one", status: "idle", pinned: false, archived: false, createdAt: task.createdAt, updatedAt: task.createdAt, ...patch };
}
function setup(tasks: ScheduledTask[] = [], implementation?: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
  const call = vi.fn((method: string, params: Record<string, unknown>) => implementation
    ? implementation(method, params)
    : Promise.resolve(method === "schedule.list" ? { tasks } : method === "session.list" ? { sessions: [session("target")] } : {}));
  const onOpenSession = vi.fn(), onClose = vi.fn();
  render(<SchedulePanel client={{ call } as unknown as RpcClient} workspaces={workspaces} defaultWorkspaceId="one" onClose={onClose} onOpenSession={onOpenSession} />);
  return { call, onOpenSession, onClose };
}
async function createForm() { fireEvent.click(await screen.findByRole("button", { name: "＋ 自定义任务" })); }
function fill() {
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "新任务" } });
  fireEvent.change(screen.getByLabelText("任务内容"), { target: { value: "持续检查" } });
}

describe("SchedulePanel", () => {
  it("selects eligible sessions by title and updates an existing heartbeat", async () => {
    const { call } = setup([task], async (method) => method === "schedule.list" ? { tasks: [task] } : method === "session.list" ? {
      sessions: [session("target"), session("other-project", { workspaceId: "two" }), session("archived", { archived: true }), session("external", { external: { provider: "codex", externalId: "x", sourcePath: "/x", continuationMode: "read_only", importedAt: task.createdAt, lastSyncedAt: task.createdAt } })],
    } : {});
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    expect(screen.getByRole("heading", { name: "编辑定时任务" })).toBeTruthy();
    await screen.findByRole("option", { name: "会话 target" });
    expect(call).toHaveBeenCalledWith("session.list", { workspaceId: "one" });
    expect(screen.queryByRole("option", { name: "会话 other-project" })).toBeNull();
    expect(screen.queryByRole("option", { name: "会话 archived" })).toBeNull();
    expect(screen.queryByRole("option", { name: "会话 external" })).toBeNull();
    expect((screen.getByLabelText("目标会话") as HTMLSelectElement).value).toBe("target");
    expect((screen.getByLabelText("执行时间") as HTMLInputElement).value).toBe("04:30");
    fireEvent.change(screen.getByLabelText("任务记忆"), { target: { value: "更新记忆" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("schedule.update", expect.objectContaining({ id: "scheduled", targetSessionId: "target", memory: "更新记忆", schedule: task.schedule })));
  });

  it("cancels an edit without reusing its id, target, or memory for a template", async () => {
    const { call } = setup([task]);
    fireEvent.click(await screen.findByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: /每日简报/ }));
    expect(screen.getByRole("heading", { name: "创建定时任务" })).toBeTruthy();
    expect((screen.getByLabelText("任务记忆") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByLabelText("目标会话")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("schedule.create", expect.objectContaining({ name: "每日简报", mode: "newSession", targetSessionId: null, memory: "" })));
    expect(call.mock.calls.some(([method]) => method === "schedule.update")).toBe(false);
    await createForm();
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("");
  });

  it("preserves new-session memory and supports custom weekdays with a time", async () => {
    const { call } = setup();
    await createForm(); fill();
    fireEvent.change(screen.getByLabelText("任务记忆"), { target: { value: "长期上下文\n保留换行" } });
    fireEvent.change(screen.getByLabelText("运行频率"), { target: { value: "weekdays" } });
    fireEvent.click(screen.getByLabelText("周二")); fireEvent.click(screen.getByLabelText("周四")); fireEvent.click(screen.getByLabelText("周六"));
    fireEvent.change(screen.getByLabelText("执行时间"), { target: { value: "04:00" } });
    fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("schedule.create", expect.objectContaining({ memory: "长期上下文\n保留换行", schedule: { type: "weekdays", weekdays: [1, 3, 5, 6], time: "04:00" } })));
    expect(describeSchedule({ type: "weekdays", weekdays: [6, 1, 3], time: "04:00" })).toBe("周一、周三、周六 04:00");
  });

  it("clears project-specific target and memory and ignores a late previous-project list", async () => {
    let resolveOld!: (value: unknown) => void;
    setup([], (method, params) => method === "schedule.list" ? Promise.resolve({ tasks: [] }) : params.workspaceId === "one"
      ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve({ sessions: [session("two", { workspaceId: "two" })] }));
    await createForm();
    fireEvent.change(screen.getByLabelText("执行方式"), { target: { value: "heartbeat" } });
    fireEvent.change(screen.getByLabelText("任务记忆"), { target: { value: "项目 one 的秘密" } });
    fireEvent.change(screen.getByLabelText("项目"), { target: { value: "two" } });
    await screen.findByRole("option", { name: "会话 two" });
    await act(async () => { resolveOld({ sessions: [session("old")] }); });
    expect(screen.queryByRole("option", { name: "会话 old" })).toBeNull();
    expect((screen.getByLabelText("任务记忆") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText("目标会话") as HTMLSelectElement).value).toBe("");
  });

  it("deduplicates a save and keeps the editable draft after failure", async () => {
    let rejectSave!: (cause: Error) => void;
    const { call } = setup([], (method) => method === "schedule.list" ? Promise.resolve({ tasks: [] }) : new Promise((_resolve, reject) => { rejectSave = reject; }));
    await createForm(); fill();
    const save = screen.getByRole("button", { name: "创建任务" });
    fireEvent.click(save); fireEvent.click(save);
    expect(call.mock.calls.filter(([method]) => method === "schedule.create")).toHaveLength(1);
    await act(async () => { rejectSave(new Error("网络暂时不可用")); });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "网络暂时不可用");
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("新任务");
    fireEvent.click(screen.getByRole("button", { name: "创建任务" }));
    expect(call.mock.calls.filter(([method]) => method === "schedule.create")).toHaveLength(2);
  });

  it("allows reloading failed target lookup without discarding the draft", async () => {
    let attempts = 0;
    setup([], async (method) => {
      if (method === "schedule.list") return { tasks: [] };
      if (++attempts === 1) throw new Error("远程暂时断开");
      return { sessions: [session("target")] };
    });
    await createForm(); fill();
    fireEvent.change(screen.getByLabelText("执行方式"), { target: { value: "heartbeat" } });
    fireEvent.click(await screen.findByRole("button", { name: "重新加载会话" }));
    expect(await screen.findByRole("option", { name: "会话 target" })).toBeTruthy();
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("新任务");
  });

  it("prevents repeated run-now requests and recovers after an error", async () => {
    let rejectRun!: (cause: Error) => void;
    const { call, onClose, onOpenSession } = setup([task], (method) => method === "schedule.list" ? Promise.resolve({ tasks: [task] }) : new Promise((_resolve, reject) => { rejectRun = reject; }));
    const run = await screen.findByRole("button", { name: "立即运行" });
    fireEvent.click(run); fireEvent.click(run);
    expect(call.mock.calls.filter(([method]) => method === "schedule.runNow")).toHaveLength(1);
    await act(async () => { rejectRun(new Error("会话正在执行，请稍后再试")); });
    expect(within(await screen.findByRole("alert")).getByText("会话正在执行，请稍后再试")).toBeTruthy();
    expect(onOpenSession).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(run);
    expect(call.mock.calls.filter(([method]) => method === "schedule.runNow")).toHaveLength(2);
  });
});
