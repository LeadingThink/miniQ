import { expect, it, vi } from "vitest";
import type { RpcClient } from "./rpc";
import { readExportHistory } from "./historyExport";

it("exports every history page, including full tool payloads and internal records", async () => {
  const call = vi.fn().mockResolvedValueOnce({messages:[{id:"new"}], toolCalls:[{id:"t-new", output:"complete"}], nextCursor:{at:"time",id:"cursor"}})
    .mockResolvedValueOnce({messages:[{id:"old"}], toolCalls:[{id:"t-old", input:"all"}], nextCursor:null});
  const signal = new AbortController().signal;
  const result = await readExportHistory({call} as unknown as RpcClient, "session", signal);
  expect(result.messages.map((message) => message.id)).toEqual(["old", "new"]);
  expect(result.toolCalls).toEqual([{id:"t-old",input:"all"},{id:"t-new",output:"complete"}]);
  expect(call).toHaveBeenLastCalledWith("session.history", {sessionId:"session", before:{at:"time",id:"cursor"}, limit:100, includePayloads:true, includeInternal:true}, {signal});
});

it("does not return a partial export after cancellation", async () => {
  const request = new AbortController();
  const call = vi.fn(async () => {request.abort(); return {messages:[], toolCalls:[], nextCursor:{at:"time",id:"next"}};});
  await expect(readExportHistory({call} as unknown as RpcClient, "session", request.signal)).rejects.toMatchObject({name:"AbortError"});
  expect(call).toHaveBeenCalledTimes(1);
});
