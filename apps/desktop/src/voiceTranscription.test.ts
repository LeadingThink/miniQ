import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "./rpc";
import { VoiceTranscription } from "./voiceTranscription";

afterEach(() => vi.useRealTimers());
function setup(call = vi.fn().mockResolvedValue({ text: "识别文字" })) {
  const update = vi.fn();
  return { call, update, voice: new VoiceTranscription({ call } as unknown as RpcClient, 16_000, update) };
}
function speak(voice: VoiceTranscription, seconds: number, value = 0.1) {
  for (let index = 0; index < seconds * 4; index++) voice.append(new Float32Array(4000).fill(value));
}
function secondsOf(encoded: string) { return (Buffer.from(encoded, "base64").length - 44) / 32_000; }

describe("live transcription", () => {
  it("revises an active phrase and preserves every sample for final correction", async () => {
    const { voice, call, update } = setup(vi.fn().mockResolvedValueOnce({ text: "请生成一个记" })
      .mockResolvedValueOnce({ text: "请生成一个计划" }).mockResolvedValueOnce({ text: "请生成一个计划。" }));
    speak(voice, 2); await voice.preview();
    expect(update).toHaveBeenLastCalledWith("请生成一个记", false);
    speak(voice, 2); await voice.preview();
    expect(voice.text).toBe("请生成一个计划");
    expect(await voice.finish()).toBe("请生成一个计划。");
    expect(call.mock.calls.map((args) => args[1].preview)).toEqual([true, true, false]);
    expect(secondsOf(call.mock.calls[2][1].audioBase64)).toBe(4);
  });

  it("bounds long-recording previews and preserves deliberate repeated phrases", async () => {
    const { voice, call } = setup(vi.fn().mockResolvedValue({ text: "再检查一次。" }));
    speak(voice, 25);
    await voice.preview();
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(3));
    expect(voice.text).toBe("再检查一次。再检查一次。再检查一次。");
    expect(call.mock.calls.every((args) => secondsOf(args[1].audioBase64) <= 8)).toBe(true);
    await voice.finish();
    expect(secondsOf(call.mock.calls.at(-1)![1].audioBase64)).toBe(25);
  });

  it("has one request in flight and finishes with all audio captured during a slow preview", async () => {
    let resolve!: (value: { text: string }) => void;
    const { voice, call } = setup(vi.fn().mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
      .mockResolvedValue({ text: "最终完整文字" }));
    speak(voice, 2); const preview = voice.preview();
    speak(voice, 4); expect(voice.preview()).toBe(preview);
    const final = voice.finish(); expect(call).toHaveBeenCalledTimes(1);
    resolve({ text: "临时文字" });
    expect(await final).toBe("最终完整文字");
    expect(call).toHaveBeenCalledTimes(2);
    expect(secondsOf(call.mock.calls[1][1].audioBase64)).toBe(6);
  });

  it("recovers delayed previews and retains audio when final recognition must be retried", async () => {
    vi.useFakeTimers();
    const { voice, call, update } = setup(vi.fn().mockRejectedValueOnce(new Error("temporary error"))
      .mockResolvedValueOnce({ text: "预览内容" }).mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ text: "最终内容" }));
    speak(voice, 3); await voice.preview();
    expect(update).toHaveBeenLastCalledWith("", true);
    await voice.preview(); expect(call).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(4000); await voice.preview();
    expect(update).toHaveBeenLastCalledWith("预览内容", false);
    await expect(voice.finish()).rejects.toThrow("offline");
    expect(await voice.finish()).toBe("最终内容");
    expect(call.mock.calls[2][1].audioBase64).toBe(call.mock.calls[3][1].audioBase64);
  });

  it("ignores a cancelled preview even if a disconnected client returns it late", async () => {
    let resolve!: (value: { text: string }) => void;
    const { voice, call, update } = setup(vi.fn().mockImplementation(() => new Promise((done) => { resolve = done; })));
    speak(voice, 2); const pending = voice.preview(); voice.cancel();
    expect(call.mock.calls[0][2].signal.aborted).toBe(true);
    resolve({ text: "旧会话文字" }); await pending;
    expect(update).not.toHaveBeenCalled(); expect(voice.duration).toBe(0);
  });
});
