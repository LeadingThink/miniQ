// @vitest-environment jsdom
import { expect, it } from "vitest";
import { fetchVoiceCapabilities } from "./voiceCapabilities";
import type { RpcClient } from "./rpc";

function clientWith(call: (method: string) => Promise<unknown>): RpcClient {
  return { call: call as RpcClient["call"] } as RpcClient;
}

it("returns transcribe and speak flags from voice.capabilities", async () => {
  const client = clientWith((method) =>
    method === "voice.capabilities"
      ? Promise.resolve({ transcribe: true, speak: true, transcribeModel: "grok-transcribe", ttsModel: "grok-tts" })
      : Promise.reject(new Error(`unexpected ${method}`)),
  );
  const result = await fetchVoiceCapabilities(client);
  expect(result).toEqual({
    transcribe: true,
    speak: true,
    transcribeModel: "grok-transcribe",
    ttsModel: "grok-tts",
  });
});

it("falls back to model.list for old daemons", async () => {
  const client = clientWith((method) => {
    if (method === "voice.capabilities") return Promise.reject(new Error("unknown method: voice.capabilities (code -32601)"));
    if (method === "model.list") return Promise.resolve({ models: ["gpt-5.6-sol", "grok-transcribe", "grok-tts"] });
    return Promise.reject(new Error(`unexpected ${method}`));
  });
  const result = await fetchVoiceCapabilities(client);
  expect(result.transcribe).toBe(true);
  expect(result.speak).toBe(true);
  expect(result.transcribeModel).toBe("grok-transcribe");
  expect(result.ttsModel).toBe("grok-tts");
});

it("does not advertise sencevoice-small through the old-daemon fallback", async () => {
  const client = clientWith((method) => {
    if (method === "voice.capabilities") return Promise.reject(new Error("unknown method: voice.capabilities (code -32601)"));
    if (method === "model.list") return Promise.resolve({ models: ["sencevoice-small"] });
    return Promise.reject(new Error(`unexpected ${method}`));
  });
  const result = await fetchVoiceCapabilities(client);
  expect(result.transcribe).toBe(false);
  expect(result.transcribeModel).toBeNull();
});

it("hides buttons when audio models are absent", async () => {
  const client = clientWith((method) =>
    method === "voice.capabilities"
      ? Promise.resolve({ transcribe: false, speak: false, transcribeModel: null, ttsModel: null })
      : Promise.reject(new Error(`unexpected ${method}`)),
  );
  const result = await fetchVoiceCapabilities(client);
  expect(result.transcribe).toBe(false);
  expect(result.speak).toBe(false);
});

it("hides buttons on capability errors", async () => {
  const client = clientWith(() => Promise.reject(new Error("请求 voice.capabilities 超时")));
  const result = await fetchVoiceCapabilities(client);
  expect(result).toEqual({ transcribe: false, speak: false, transcribeModel: null, ttsModel: null });
});
