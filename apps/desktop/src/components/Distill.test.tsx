// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RpcClient } from "../rpc";
import { DistillModal } from "./Distill";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function renderDistill(client: RpcClient, onClose = vi.fn()) {
  return render(<DistillModal client={client} sessionId="session-a" onClose={onClose} />);
}

it("keeps a distill job alive after closing and restores its draft when reopened", async () => {
  const client = new RpcClient();
  const result = deferred<{ id: string; state: "completed"; result: { skipped: false; content: string; name: string } }>();
  const call = vi.spyOn(client, "call").mockImplementation(async (method) => {
    if (method === "skill.job.start") return { id: "job-1", state: "running" } as never;
    if (method === "skill.job.get") return result.promise as never;
    throw new Error(`unexpected ${method}`);
  });
  const first = renderDistill(client);
  await screen.findByText("正在从本会话提炼技能…");
  expect(call).toHaveBeenCalledWith("skill.job.start", { kind: "distill", sessionId: "session-a" });
  first.unmount();

  await act(async () => {
    result.resolve({ id: "job-1", state: "completed", result: { skipped: false, content: "后台完成的技能", name: "示例技能" } });
    await result.promise;
  });

  renderDistill(client);
  expect(await screen.findByDisplayValue("后台完成的技能")).toBeTruthy();
  expect(call.mock.calls.filter(([method]) => method === "skill.job.start")).toHaveLength(1);
});

it("continues refining after the panel is closed and makes the result recoverable", async () => {
  const client = new RpcClient();
  const refine = deferred<{ id: string; state: "completed"; result: { kept: false; content: string } }>();
  let getCount = 0;
  const call = vi.spyOn(client, "call").mockImplementation(async (method, params) => {
    if (method === "skill.job.start") {
      return { id: params && (params as { kind?: string }).kind === "refine" ? "refine-1" : "distill-1", state: "running" } as never;
    }
    if (method === "skill.job.get") {
      getCount += 1;
      if (getCount === 1) return { id: "distill-1", state: "completed", result: { skipped: false, content: "初稿", name: "同名技能", existingSkill: true } } as never;
      return refine.promise as never;
    }
    throw new Error(`unexpected ${method}`);
  });
  const first = renderDistill(client);
  expect(await screen.findByDisplayValue("初稿")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "改为更新已有技能" }));
  first.unmount();

  await act(async () => {
    refine.resolve({ id: "refine-1", state: "completed", result: { kept: false, content: "后台完成的更新" } });
    await refine.promise;
  });
  renderDistill(client);
  expect(await screen.findByDisplayValue("后台完成的更新")).toBeTruthy();
  expect(call.mock.calls.filter(([method]) => method === "skill.job.start")).toHaveLength(2);
});


it("shows a retryable failure instead of an empty editor", async () => {
  const client = new RpcClient();
  let starts = 0;
  vi.spyOn(client, "call").mockImplementation(async method => {
    if (method === "skill.job.start") return { id: `job-${++starts}`, state: "running" } as never;
    return (starts === 1 ? { state: "failed", error: "生成失败" } : { state: "completed", result: { content: "重试成功" } }) as never;
  });
  renderDistill(client);
  expect(await screen.findByText("生成失败")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByDisplayValue("重试成功")).toBeTruthy();
  expect(starts).toBe(2);
});

it("preserves edited draft when refinement fails", async () => {
  const client = new RpcClient();
  let refining = false;
  vi.spyOn(client, "call").mockImplementation(async (method, params) => {
    if (method === "skill.job.start") {
      refining = (params as { kind: string }).kind === "refine";
      return { id: "job" } as never;
    }
    return (refining ? { state: "failed", error: "更新失败" } : { state: "completed", result: { content: "初稿", name: "技能", existingSkill: true } }) as never;
  });
  renderDistill(client);
  fireEvent.change(await screen.findByRole("textbox"), { target: { value: "我的修改" } });
  fireEvent.click(screen.getByRole("button", { name: "改为更新已有技能" }));
  await screen.findByText("更新失败");
  fireEvent.click(screen.getByRole("button", { name: "返回原草稿" }));
  expect(screen.getByDisplayValue("我的修改")).toBeTruthy();
});

it("cancels explicitly and ignores a late result after retry", async () => {
  const client = new RpcClient();
  const old = deferred<unknown>();
  let starts = 0;
  const call = vi.spyOn(client, "call").mockImplementation(async method => {
    if (method === "skill.job.start") return { id: `job-${++starts}` } as never;
    if (method === "skill.job.cancel") return { state: "cancelled" } as never;
    return (starts === 1 ? old.promise : { state: "completed", result: { content: "新草稿" } }) as never;
  });
  renderDistill(client);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "取消任务" }));
  await screen.findByRole("button", { name: "重试" });
  expect(call).toHaveBeenCalledWith("skill.job.cancel", { sessionId: "session-a", jobId: "job-1" });
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByDisplayValue("新草稿");
  await act(async () => { old.resolve({ state: "completed", result: { content: "过期草稿" } }); });
  expect(screen.getByDisplayValue("新草稿")).toBeTruthy();
  expect(screen.queryByDisplayValue("过期草稿")).toBeNull();
});

it.each([true, false])("disables duplicate saves and displays returned location (path=%s)", async withPath => {
  const client = new RpcClient();
  const saved = deferred<unknown>();
  const call = vi.spyOn(client, "call").mockImplementation(async method => {
    if (method === "skill.job.start") return { id: "job" } as never;
    if (method === "skill.save") return saved.promise as never;
    return { state: "completed", result: { content: "草稿", name: "原名称" } } as never;
  });
  const panel = renderDistill(client);
  fireEvent.click(await screen.findByRole("button", { name: "保存技能" }));
  const pending = screen.getByRole("button", { name: "正在保存…" }) as HTMLButtonElement;
  expect(pending.disabled).toBe(true);
  fireEvent.click(pending);
  panel.unmount();
  renderDistill(client);
  expect((screen.getByRole("button", { name: "正在保存…" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { saved.resolve({ name: "最终名称", version: 3, ...(withPath ? { path: "/users/test/skills/final/SKILL.md" } : {}) }); });
  expect(await screen.findByText("最终名称 · 版本 3")).toBeTruthy();
  expect(screen.getByText(withPath ? "保存位置：/users/test/skills/final/SKILL.md" : "已保存到用户技能目录（服务端未返回完整路径）。")).toBeTruthy();
  expect(call.mock.calls.filter(([method]) => method === "skill.save")).toHaveLength(1);
});

it("bounds a never-settling status call and checks the same job without another start", async () => {
  vi.useFakeTimers();
  const client = new RpcClient();
  let gets = 0;
  const call = vi.spyOn(client, "call").mockImplementation(async method => {
    if (method === "skill.job.start") return { id: "job" } as never;
    return (++gets === 1 ? new Promise(() => {}) : { state: "completed", result: { content: "恢复的草稿" } }) as never;
  });
  renderDistill(client);
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
  expect(screen.getByText(/等待已超时/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "检查状态" }));
  await act(async () => {});
  expect(screen.getByDisplayValue("恢复的草稿")).toBeTruthy();
  expect(call.mock.calls.filter(([method]) => method === "skill.job.start")).toHaveLength(1);
});

it("bounds a never-settling start and recovers its late job id without duplicate start", async () => {
  vi.useFakeTimers();
  const client = new RpcClient();
  const start = deferred<unknown>();
  const call = vi.spyOn(client, "call").mockImplementation(async method => {
    if (method === "skill.job.start") return start.promise as never;
    return { state: "completed", result: { content: "迟到的草稿" } } as never;
  });
  renderDistill(client);
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
  expect(screen.getByText(/等待已超时/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "检查状态" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { start.resolve({ id: "late-job" }); });
  fireEvent.click(screen.getByRole("button", { name: "检查状态" }));
  await act(async () => {});
  expect(screen.getByDisplayValue("迟到的草稿")).toBeTruthy();
  expect(call.mock.calls.filter(([method]) => method === "skill.job.start")).toHaveLength(1);
});

it("isolates in-flight snapshots across session and client changes", async () => {
  const client = new RpcClient();
  const otherClient = new RpcClient();
  const old = deferred<unknown>();
  vi.spyOn(client, "call").mockImplementation(async (method, params) => {
    const session = (params as { sessionId: string }).sessionId;
    if (method === "skill.job.start") return { id: session } as never;
    return (session === "session-a" ? old.promise : { state: "completed", result: { content: "B 草稿" } }) as never;
  });
  vi.spyOn(otherClient, "call").mockImplementation(async method => (method === "skill.job.start" ? { id: "other" } : { state: "completed", result: { content: "另一客户端" } }) as never);
  const panel = renderDistill(client);
  await act(async () => {});
  panel.rerender(<DistillModal client={client} sessionId="session-b" onClose={vi.fn()} />);
  await screen.findByDisplayValue("B 草稿");
  await act(async () => { old.resolve({ state: "completed", result: { content: "A 草稿" } }); });
  expect(screen.getByDisplayValue("B 草稿")).toBeTruthy();
  panel.rerender(<DistillModal client={otherClient} sessionId="session-b" onClose={vi.fn()} />);
  expect(screen.queryByDisplayValue("B 草稿")).toBeNull();
  await screen.findByDisplayValue("另一客户端");
  panel.rerender(<DistillModal client={client} sessionId="session-a" onClose={vi.fn()} />);
  expect(screen.getByDisplayValue("A 草稿")).toBeTruthy();
});


it("treats an RPC timeout as uncertain status instead of allowing duplicate generation", async () => {
  const client = new RpcClient();
  let gets = 0;
  const call = vi.spyOn(client, "call").mockImplementation(async method => {
    if (method === "skill.job.start") return { id: "job" } as never;
    if (++gets === 1) throw new Error("RPC timeout");
    return { state: "completed", result: { content: "恢复" } } as never;
  });
  renderDistill(client);
  await screen.findByText(/任务状态未确认/);
  expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "检查状态" }));
  await screen.findByDisplayValue("恢复");
  expect(call.mock.calls.filter(([method]) => method === "skill.job.start")).toHaveLength(1);
});


it("bounds saving and prevents duplicate writes while accepting a late success", async () => {
  vi.useFakeTimers();
  const client = new RpcClient();
  const saved = deferred<unknown>();
  const call = vi.spyOn(client, "call").mockImplementation(async method => {
    if (method === "skill.job.start") return { id: "job" } as never;
    if (method === "skill.save") return saved.promise as never;
    return { state: "completed", result: { content: "草稿" } } as never;
  });
  renderDistill(client);
  await act(async () => {});
  expect(screen.getByRole("textbox", { name: "技能草稿" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存技能" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
  expect(screen.getByRole("alert").textContent).toContain("保存结果未确认");
  const button = screen.getByRole("button", { name: "保存结果待确认" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(call.mock.calls.filter(([method]) => method === "skill.save")).toHaveLength(1);
  await act(async () => { saved.resolve({ name: "技能", path: "/skills/test/SKILL.md" }); });
  expect(screen.getByText("保存位置：/skills/test/SKILL.md")).toBeTruthy();
});

it.each(["connection closed", "服务拒绝 (code -32000)"])("only offers a new start for a known rejection: %s", async message => {
  const client = new RpcClient();
  vi.spyOn(client, "call").mockRejectedValue(new Error(message));
  renderDistill(client);
  await screen.findByRole("alert");
  expect(Boolean(screen.queryByRole("button", { name: "重试" }))).toBe(message.includes("code"));
});
