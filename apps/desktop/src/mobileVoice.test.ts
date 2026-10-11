// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createMobileVoiceTranscriber, fetchMobileVoiceCapabilities } from "./mobileVoice";
const signal = () => new AbortController().signal;
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("discovers audio models with the phone's key directly at the fixed service", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{id:"sencevoice-small"}] })));
  vi.stubGlobal("fetch", fetch);
  expect(await fetchMobileVoiceCapabilities("phone-key")).toEqual({transcribe:true,transcribeModel:"sencevoice-small"});
  expect(fetch).toHaveBeenCalledWith("https://oneapi.zaiwenai.com/v1/models",expect.objectContaining({headers:{Authorization:"Bearer phone-key"},redirect:"error"}));
});
it("sends binary WAV in multipart without relay encoding", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({text:" 测试 "})));
  vi.stubGlobal("fetch",fetch);
  expect(await createMobileVoiceTranscriber("phone-key")(new Uint8Array(100),false,signal())).toBe("测试");
  const [url, options] = fetch.mock.calls[0]; expect(url).toBe("https://oneapi.zaiwenai.com/v1/audio/transcriptions");
  expect(options.body.get("file").size).toBe(100); expect(options.body.get("file").type).toBe("audio/wav");
  expect(options.body.get("model")).toBe("grok-transcribe");
});
it("does not fall back to a computer or echo sensitive provider errors",async()=>{
  const fetch = vi.fn().mockResolvedValue(new Response("secret audio key",{status:401}));vi.stubGlobal("fetch",fetch);
  await expect(createMobileVoiceTranscriber("phone-key")(new Uint8Array(100),false,signal())).rejects.toThrow("手机上的 API Key");
  expect(fetch).toHaveBeenCalledOnce();
});
it("propagates cancellation and bounds a hanging request", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn((_url, init) => new Promise((_resolve, reject) => {
    if(init.signal.aborted) reject(init.signal.reason);
    else init.signal.addEventListener("abort",()=>reject(init.signal.reason),{once:true});
  })); vi.stubGlobal("fetch",fetch);
  const pending = createMobileVoiceTranscriber("key")(new Uint8Array(100),true,signal());
  const check = expect(pending).rejects.toThrow("超时"); await vi.advanceTimersByTimeAsync(20_000); await check;
  const controller = new AbortController();const cancelled=createMobileVoiceTranscriber("key")(new Uint8Array(100),false,controller.signal);
  const cancelCheck=expect(cancelled).rejects.toThrow();controller.abort();await cancelCheck;
});
it("rejects missing keys and oversized audio before upload",async()=>{
  const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
  await expect(createMobileVoiceTranscriber("")(new Uint8Array(100),false,signal())).rejects.toThrow("API Key");
  await expect(createMobileVoiceTranscriber("key")(new Uint8Array(13*1024*1024),false,signal())).rejects.toThrow("12 MB");
  expect(fetch).not.toHaveBeenCalled();
});

it("retries a transient final failure with the same WAV but never retries preview uploads", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValueOnce(new Response("", {status:503}))
    .mockResolvedValueOnce(new Response(JSON.stringify({text:"恢复"})))
    .mockResolvedValueOnce(new Response("", {status:503}));
  vi.stubGlobal("fetch",fetch);
  const final=createMobileVoiceTranscriber("key")(new Uint8Array(100),false,signal());
  await vi.advanceTimersByTimeAsync(500);expect(await final).toBe("恢复");
  expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
  await expect(createMobileVoiceTranscriber("key")(new Uint8Array(100),true,signal())).rejects.toThrow("503");
  expect(fetch).toHaveBeenCalledTimes(3);
});
