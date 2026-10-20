// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useFilePreview } from "./useFilePreview";
import { readLocalFilePreview } from "../localFiles";
import type { RpcClient } from "../rpc";

vi.mock("../runtime", () => ({ isTauriRuntime: () => false }));
vi.mock("../localFiles", async (original) => ({
  ...await original<typeof import("../localFiles")>(), readLocalFilePreview: vi.fn(),
}));
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

const target = { path: "/outside/link.txt", line: null, column: null };
const canonical = "/outside/report.txt";

function fixture() {
  const allowed = new Set<string>();
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "file.access.request") return { requestId: "confirmation", path: canonical };
    if (method === "file.access.resolve") {
      if (params.allow) allowed.add(String(params.sessionId));
      return { allowed: params.allow, path: canonical };
    }
    throw new Error(`unexpected ${method}`);
  });
  const client = { mode: "remote", call } as unknown as RpcClient;
  vi.mocked(readLocalFilePreview).mockImplementation(async (path, _workspace, _roots, options) => {
    if (!allowed.has(options!.sessionId!) || path !== canonical) {
      throw new Error(`拒绝打开当前会话未授权的文件: ${path}`);
    }
    return { path, kind:"text", mimeType:"text/plain", content:"synthetic report", size:16, dataBase64:null };
  });
  const hook = renderHook(({ session }) => useFilePreview("/project", session, undefined, client), {
    initialProps: { session: "first" },
  });
  return { hook, call };
}

it("requires a separate explicit confirmation, then previews only the canonical file in that session", async () => {
  const { hook, call } = fixture();
  await act(async () => hook.result.current.openFile(target));
  expect(hook.result.current.state.canAuthorize).toBe(true);
  expect(call).not.toHaveBeenCalled();
  await act(async () => hook.result.current.authorizeFile(target));
  expect(call).toHaveBeenCalledTimes(1);
  expect(hook.result.current.state.authorization?.path).toBe(canonical);
  expect(hook.result.current.state.content).toBeNull();
  const confirmation = hook.result.current.state.authorization!;
  await act(async () => { await confirmation.confirm(); await confirmation.confirm(); });
  expect(call).toHaveBeenCalledTimes(2);
  expect(call).toHaveBeenLastCalledWith("file.access.resolve", {sessionId:"first", requestId:"confirmation", allow:true}, expect.any(Object));
  expect(hook.result.current.state.content).toBe("synthetic report");
  expect(hook.result.current.state.target?.path).toBe(canonical);
  expect(hook.result.current.authorizedFiles).toEqual([]);
  await act(async () => hook.result.current.openFile({ ...target, path: "/outside/neighbor.txt" }));
  expect(hook.result.current.state.content).toBeNull();
  hook.rerender({session:"second"});
  await act(async () => hook.result.current.openFile({...target, path:canonical}));
  expect(hook.result.current.state.content).toBeNull();
  expect(hook.result.current.state.canAuthorize).toBe(true);
});

it("rejects the challenge without reading or granting", async () => {
  const { hook, call } = fixture();
  await act(async () => hook.result.current.openFile(target));
  await act(async () => hook.result.current.authorizeFile(target));
  await act(async () => hook.result.current.state.authorization!.cancel());
  expect(call).toHaveBeenLastCalledWith("file.access.resolve", {sessionId:"first", requestId:"confirmation", allow:false}, expect.any(Object));
  expect(readLocalFilePreview).toHaveBeenCalledOnce();
  expect(hook.result.current.state.authorization).toBeUndefined();
  await act(async () => hook.result.current.openFile({...target, path:canonical}));
  expect(hook.result.current.state.content).toBeNull();
});

it("invalidates a displayed confirmation when the user switches session", async () => {
  const { hook, call } = fixture();
  await act(async () => hook.result.current.openFile(target));
  await act(async () => hook.result.current.authorizeFile(target));
  const stale = hook.result.current.state.authorization!;
  hook.rerender({session:"second"});
  await act(async () => stale.confirm());
  expect(call).toHaveBeenCalledTimes(1);
  expect(hook.result.current.state.authorization).toBeUndefined();
  expect(hook.result.current.state.open).toBe(false);
});

it("discards a late confirmation request after the preview closes", async () => {
  const { hook, call } = fixture();
  let resolve!: (value: {requestId:string;path:string}) => void;
  call.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => hook.result.current.openFile(target));
  let pending!: Promise<void>;
  act(() => { pending = hook.result.current.authorizeFile(target); });
  act(() => hook.result.current.close());
  await act(async () => { resolve({requestId:"late",path:canonical}); await pending; });
  expect(hook.result.current.state.authorization).toBeUndefined();
  expect(hook.result.current.state.open).toBe(false);
});

it("does not turn a storage 403 into file authorization", async () => {
  const { hook, call } = fixture();
  vi.mocked(readLocalFilePreview).mockRejectedValueOnce(new Error("File storage request failed (403)"));
  await act(async () => hook.result.current.openFile(target));
  expect(hook.result.current.state.canAuthorize).toBe(false);
  expect(call).not.toHaveBeenCalled();
});
