// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { AutomaticVoice } from "./automaticVoice";
import { startAppleSpeech, type LocalSpeech } from "./appleSpeech";
vi.mock("./appleSpeech", () => ({ startAppleSpeech: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const audio = () => new Float32Array(32_000).fill(0.2);
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function setup() {
  let partial!: (text: string) => void;
  let fail!: (error: Error) => void;
  const local = { append: vi.fn().mockResolvedValue(undefined), finish: vi.fn().mockResolvedValue("本地完整文字"), cancel: vi.fn() };
  vi.mocked(startAppleSpeech).mockImplementation(async (_rate, p, f) => { partial = p; fail = f; return local; });
  const api = vi.fn().mockResolvedValue("API完整文字");
  const update = vi.fn();
  const recognition = new AutomaticVoice(api, 16_000, update, undefined, true);
  return { recognition, api, update, local, partial: (text: string) => partial(text), fail: () => fail(new Error("offline")) };
}
it("uses streaming local text without uploading any audio on success", async () => {
  const f = setup(); f.recognition.append(audio()); await tick(); f.partial("本地预览");
  await f.recognition.preview();
  expect(f.update).toHaveBeenLastCalledWith("本地预览", false);
  expect(await f.recognition.finish()).toBe("本地完整文字");
  expect(f.local.append).toHaveBeenCalledOnce(); expect(f.api).not.toHaveBeenCalled();
  f.recognition.cancel();
});
it("falls back after startup failure with the complete recording", async () => {
  const api = vi.fn().mockResolvedValue("完整");
  vi.mocked(startAppleSpeech).mockRejectedValue(new Error("no language assets"));
  const r = new AutomaticVoice(api, 16000, vi.fn(), undefined, true);
  r.append(audio()); r.append(audio());
  expect(await r.finish()).toBe("完整");
  expect(api.mock.calls.at(-1)![0].length).toBe(44 + 64000 * 2);
  expect(api.mock.calls.at(-1)![1]).toBe(false); r.cancel();
});
it("replaces local partials after mid-recording fallback without dropping earlier samples", async () => {
  const f = setup(); f.recognition.append(audio()); await tick(); f.partial("已有文字"); f.fail();
  f.recognition.append(audio()); await tick();
  expect(await f.recognition.finish()).toBe("API完整文字");
  expect(f.api.mock.calls.at(-1)![0].length).toBe(44 + 64000 * 2);
  f.partial("迟到的本地结果"); expect(f.recognition.text).not.toBe("迟到的本地结果");
  f.recognition.cancel();
});
it("falls back when native finish fails or returns empty", async () => {
  for (const error of [true, false]) {
    const f = setup(); f.recognition.append(audio()); await tick();
    if (error) f.local.finish.mockRejectedValue(new Error("timeout")); else f.local.finish.mockResolvedValue("");
    expect(await f.recognition.finish()).toBe("API完整文字"); f.recognition.cancel();
  }
});
it("does not upload or publish results after cancellation during native startup", async () => {
  let ready!: (local: LocalSpeech) => void;
  const api = vi.fn(); const update = vi.fn(); const local = { append: vi.fn(), finish: vi.fn(), cancel: vi.fn() };
  vi.mocked(startAppleSpeech).mockImplementation(() => new Promise((resolve) => { ready = resolve; }));
  const r = new AutomaticVoice(api, 16000, update, undefined, true);
  r.append(audio()); r.cancel(); ready(local); await tick();
  expect(local.cancel).toHaveBeenCalled(); expect(api).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
});
it("direct API mode never starts native recognition and supports retry without another capture", async () => {
  const api = vi.fn().mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce("重试成功");
  const r = new AutomaticVoice(api, 16000, vi.fn()); r.append(audio());
  await expect(r.finish()).rejects.toThrow("network"); expect(await r.finish()).toBe("重试成功");
  expect(startAppleSpeech).not.toHaveBeenCalled(); expect(api.mock.calls[0][0]).toEqual(api.mock.calls[1][0]); r.cancel();
});
it("serializes native appends and finishes only after queued PCM has been accepted", async () => {
  const f = setup(); let resume!: () => void;
  f.local.append.mockImplementationOnce(() => new Promise<void>((resolve) => { resume = resolve; }));
  f.recognition.append(audio()); await tick(); f.recognition.append(audio());
  const result = f.recognition.finish(); await tick(); expect(f.local.finish).not.toHaveBeenCalled();
  resume(); expect(await result).toBe("本地完整文字"); expect(f.local.append).toHaveBeenCalledTimes(2); f.recognition.cancel();
});
