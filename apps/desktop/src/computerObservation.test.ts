import { describe, expect, it, vi } from "vitest";
import { loadObservation, observationImage } from "./computerObservation";
import type { RpcClient } from "./rpc";
import type { ToolCall } from "./types";

const screenshot = { id: "aa8091e1-3bf0-4b0f-b699-260f2ac9e081", width: 1280, height: 820, bytes: 6 };
const call: ToolCall = { id:"call-1", sessionId:"session-1", toolName:"computer_use", input:{action:"screenshot"}, output:{screenshot}, status:"succeeded", createdAt:"2026-09-06T01:00:00Z" };

describe("computer observations", () => {
  it("only renders valid host-generated observations", () => {
    expect(observationImage(call)).toEqual(screenshot);
    expect(observationImage({...call, toolName:"shell_run"})).toBeNull();
    for (const value of [{id:"../../secret"}, {bytes:0}, {bytes:30_000_000}, {width:-1}, {height:NaN}]) {
      expect(observationImage({...call, output:{screenshot:{...screenshot,...value}}})).toBeNull();
    }
  });
  it("reassembles every chunk and scopes requests to the tool call", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({offset:0,nextOffset:3,totalBytes:6,done:false,mimeType:"image/png",base64:btoa("abc")})
      .mockResolvedValueOnce({offset:3,nextOffset:6,totalBytes:6,done:true,mimeType:"image/png",base64:btoa("def")});
    const blob = await loadObservation({call:rpc} as unknown as RpcClient, call, new AbortController().signal);
    expect(await blob.text()).toBe("abcdef");
    expect(rpc).toHaveBeenNthCalledWith(2,"observation.read",{sessionId:"session-1",toolCallId:"call-1",offset:3});
  });
  it("rejects missing, mismatched or zero-length chunks", async () => {
    for (const patch of [{offset:1},{nextOffset:2},{totalBytes:4},{done:true},{mimeType:"text/html"},{base64:""}]) {
      const rpc = vi.fn().mockResolvedValue({offset:0,nextOffset:3,totalBytes:6,done:false,mimeType:"image/png",base64:btoa("abc"),...patch});
      await expect(loadObservation({call:rpc} as unknown as RpcClient,call,new AbortController().signal)).rejects.toThrow();
      expect(rpc).toHaveBeenCalledTimes(1);
    }
  });
  it("cancels without starting another chunk", async () => {
    const controller = new AbortController();
    controller.abort();
    const rpc = vi.fn();
    await expect(loadObservation({call:rpc} as unknown as RpcClient,call,controller.signal)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });
});
