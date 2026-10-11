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

it("keeps a distill request alive after closing and restores its draft when reopened", async () => {
  const client = new RpcClient();
  const request = deferred<{ skipped: false; content: string; name: string }>();
  const call = vi.spyOn(client, "call").mockReturnValue(request.promise as never);
  const first = renderDistill(client);

  expect(call).toHaveBeenCalledExactlyOnceWith("skill.distill", { sessionId: "session-a" });
  first.unmount();
  await act(async () => {
    request.resolve({ skipped: false, content: "后台完成的技能", name: "示例技能" });
    await request.promise;
  });

  renderDistill(client);
  expect(await screen.findByDisplayValue("后台完成的技能")).toBeTruthy();
  expect(call).toHaveBeenCalledExactlyOnceWith("skill.distill", { sessionId: "session-a" });
});

it("continues refining after the panel is closed and makes the result recoverable", async () => {
  const client = new RpcClient();
  const initial = Promise.resolve({ skipped: false as const, content: "初稿", name: "同名技能", existingSkill: true });
  const refined = deferred<{ kept: false; content: string }>();
  const call = vi.spyOn(client, "call")
    .mockReturnValueOnce(initial as never)
    .mockReturnValueOnce(refined.promise as never);
  const first = renderDistill(client);
  expect(await screen.findByDisplayValue("初稿")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "改为更新已有技能" }));
  first.unmount();

  await act(async () => {
    refined.resolve({ kept: false, content: "后台完成的更新" });
    await refined.promise;
  });
  renderDistill(client);
  expect(await screen.findByDisplayValue("后台完成的更新")).toBeTruthy();
  expect(call).toHaveBeenCalledTimes(2);
});
