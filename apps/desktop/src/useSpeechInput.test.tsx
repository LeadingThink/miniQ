// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "./rpc";
import { useSpeechInput } from "./useSpeechInput";
import { appleSpeechAvailable } from "./appleSpeech";
import { isTauriRuntime } from "./runtime";
vi.mock("./appleSpeech", () => ({ appleSpeechAvailable: vi.fn(async () => false) }));
vi.mock("./runtime", () => ({ isTauriRuntime: vi.fn(() => false) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.mocked(appleSpeechAvailable).mockResolvedValue(false); vi.mocked(isTauriRuntime).mockReturnValue(false); });
it("uses phone capabilities and audio HTTP requests even with a disconnected computer",async()=>{
  const call=vi.fn().mockRejectedValue(new Error("computer offline"));
  const client={mode:"remote",remoteConnection:{apiKey:"phone-key"},call} as unknown as RpcClient;
  const fetch=vi.fn().mockImplementation(async(url)=>new Response(JSON.stringify(String(url).endsWith("/models")?{data:[{id:"grok-transcribe"}]}:{text:"手机识别"})));
  vi.stubGlobal("fetch",fetch);
  const {result}=renderHook(()=>useSpeechInput(client));
  await waitFor(()=>expect(result.current.capabilities.transcribe).toBe(true));
  expect(result.current.preferLocal).toBe(false);
  expect(await result.current.transcriber!(new Uint8Array(100),false,new AbortController().signal)).toBe("手机识别");
  expect(call).not.toHaveBeenCalled(); expect(appleSpeechAvailable).not.toHaveBeenCalled();
});
it("shows local mic without waiting for a slow or unconfigured API",async()=>{
  vi.mocked(isTauriRuntime).mockReturnValue(true);vi.mocked(appleSpeechAvailable).mockResolvedValue(true);
  let reject!: (error:Error)=>void;
  const call=vi.fn(()=>new Promise((_resolve,r)=>{reject=r;}));
  const client = {call} as unknown as RpcClient;
  const {result}=renderHook(()=>useSpeechInput(client));
  await waitFor(()=>expect(result.current.preferLocal).toBe(true));expect(result.current.loading).toBe(false);
  await act(async()=>reject(new Error("no key")));
  expect(result.current.capabilities.transcribe).toBe(true);expect(result.current.transcriber).toBeUndefined();
});
it("does not substitute a computer key when phone authorization fails",async()=>{
  const call=vi.fn();vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response("",{status:401})));
  const client={mode:"remote",remoteConnection:{apiKey:"bad-phone-key"},call} as unknown as RpcClient;
  const {result}=renderHook(()=>useSpeechInput(client));
  await waitFor(()=>expect(result.current.loading).toBe(false));expect(result.current.capabilities.transcribe).toBe(false);
  expect(call).not.toHaveBeenCalled();
});
