// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { appleSpeechAvailable, startAppleSpeech } from "./appleSpeech";
import { isTauriRuntime } from "./runtime";
vi.mock("./runtime",()=>({isTauriRuntime:vi.fn(()=>true)}));
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn(),Channel:class { onmessage?: (value: unknown)=>void; }}));
afterEach(()=>{vi.resetAllMocks();vi.mocked(isTauriRuntime).mockReturnValue(true);vi.useRealTimers();});
const tick=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
it("capability probing never starts recognition or requests permission",async()=>{
  vi.mocked(invoke).mockResolvedValue(true);expect(await appleSpeechAvailable()).toBe(true);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("apple_speech_available",expect.any(Object));
});
it("non-native callers never invoke the Apple bridge",async()=>{
  vi.mocked(isTauriRuntime).mockReturnValue(false);expect(await appleSpeechAvailable()).toBe(false);expect(invoke).not.toHaveBeenCalled();
});
it("routes streaming and final events only to their session",async()=>{
  let channel:any,id="";
  vi.mocked(invoke).mockImplementation(async(method,args:any)=>{
    if(method==="apple_speech_start"){channel=args.onEvent;id=args.id;queueMicrotask(()=>channel.onmessage({id,kind:"ready",text:""}));}
    if(method==="apple_speech_finish")queueMicrotask(()=>channel.onmessage({id,kind:"final",text:"完整内容"}));
  });
  const partial=vi.fn(),failed=vi.fn();const local=await startAppleSpeech(16000,partial,failed,new AbortController().signal);
  channel.onmessage({id:"other",kind:"partial",text:"别的会话"});expect(partial).not.toHaveBeenCalled();
  channel.onmessage({id,kind:"partial",text:"预览"});expect(partial).toHaveBeenCalledWith("预览");
  await local.append(new Float32Array([0.1]));expect(await local.finish()).toBe("完整内容");expect(failed).not.toHaveBeenCalled();
  channel.onmessage({id,kind:"partial",text:"过期"});expect(partial).toHaveBeenCalledTimes(1);
});
it("cancels a slow native startup and ignores a late ready event",async()=>{
  let channel:any,id="";let complete!:()=>void;
  vi.mocked(invoke).mockImplementation((method,args:any)=>{
    if(method==="apple_speech_start"){channel=args.onEvent;id=args.id;return new Promise<void>(resolve=>{complete=resolve;});}
    return Promise.resolve();
  });
  const abort=new AbortController();const partial=vi.fn();
  const pending=startAppleSpeech(16000,partial,vi.fn(),abort.signal);const check=expect(pending).rejects.toThrow();abort.abort();await check;
  complete();await tick();channel.onmessage({id,kind:"ready",text:""});channel.onmessage({id,kind:"partial",text:"迟到"});
  expect(partial).not.toHaveBeenCalled();expect(invoke).toHaveBeenCalledWith("apple_speech_cancel",{id});
});
it("bounds a hung native startup",async()=>{
  vi.useFakeTimers();vi.mocked(invoke).mockResolvedValue(undefined);
  const pending=startAppleSpeech(16000,vi.fn(),vi.fn(),new AbortController().signal);
  const check=expect(pending).rejects.toThrow("local-start-timeout");await vi.advanceTimersByTimeAsync(20_000);await check;
});
