// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RpcClient } from "../rpc";
import { DistillModal } from "./Distill";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
