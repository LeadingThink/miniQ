// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { MAX_SPEECH_CHARS, SpeakButton, splitTextForSpeech } from "./SpeakButton";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(
  call: (method: string, params?: unknown) => Promise<unknown>,
  onError: (message: string) => void = () => undefined,
  text = "你好，欢迎使用在问。",
) {
  const client = { call: vi.fn(call) } as unknown as RpcClient;
  render(<SpeakButton client={client} text={text} onError={onError} />);
  return client as unknown as { call: ReturnType<typeof vi.fn> };
}

it("splits long text at Unicode-safe sentence boundaries without loss", () => {
  const text = `\n第一段。${"😀".repeat(5)}第二段！第三段？ `;
  const chunks = splitTextForSpeech(text, 10);
  expect(chunks.join("")).toBe(text);
  expect(chunks.every((chunk) => Array.from(chunk).length <= 10)).toBe(true);
  expect(splitTextForSpeech("   ")).toEqual([]);
  expect(MAX_SPEECH_CHARS).toBe(1500);
});

it("calls voice.speak and plays returned audio", async () => {
  const audioBase64 = btoa("fake-mp3-bytes");
  const play = vi.fn().mockResolvedValue(undefined);
  class FakeAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    pause = vi.fn();
    play = play;
    constructor(public src?: string) {}
  }
  vi.stubGlobal("Audio", FakeAudio);
  const revoke = vi.fn();
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:fake",
    revokeObjectURL: revoke,
  } as unknown as typeof URL);
  const onError = vi.fn();
  const client = setup((method, params) => {
    expect(method).toBe("voice.speak");
    expect((params as { text: string }).text).toContain("欢迎使用");
    return Promise.resolve({ audioBase64, mimeType: "audio/mpeg" });
  }, onError);
  fireEvent.click(screen.getByRole("button", { name: "朗读消息" }));
  await screen.findByRole("button", { name: "停止朗读" });
  expect(onError).not.toHaveBeenCalled();
  expect(client.call).toHaveBeenCalledWith("voice.speak", { text: "你好，欢迎使用在问。" }, { signal: expect.any(AbortSignal) });
  expect(play).toHaveBeenCalled();
});

it("reports synthesis errors", async () => {
  const onError = vi.fn();
  const client = { call: vi.fn().mockRejectedValue(new Error("语音合成鉴权失败，请检查 API Key (code 401)")) } as unknown as RpcClient;
  render(<SpeakButton client={client} text="你好" onError={onError} />);
  fireEvent.click(screen.getByRole("button", { name: "朗读消息" }));
  await vi.waitFor(() => expect(onError).toHaveBeenCalled());
  expect(onError.mock.calls[0][0]).toContain("鉴权失败");
});

it("plays long messages sequentially and retries only the failed chunk", async () => {
  const audioBase64 = btoa("fake-mp3-bytes");
  const play = vi.fn(function (this: { onended: (() => void) | null }) {
    queueMicrotask(() => this.onended?.());
    return Promise.resolve();
  });
  class FakeAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    pause = vi.fn();
    play = play;
    constructor(public src?: string) {}
  }
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:fake",
    revokeObjectURL: vi.fn(),
  } as unknown as typeof URL);
  const text = `${"甲".repeat(1500)}。${"乙".repeat(1500)}。${"丙".repeat(20)}`;
  let calls = 0;
  const requested: string[] = [];
  setup((_method, params) => {
    calls += 1;
    requested.push((params as { text: string }).text);
    if (calls === 2) return Promise.reject(new Error("temporary provider error"));
    return Promise.resolve({ audioBase64, mimeType: "audio/mpeg" });
  }, () => undefined, text);
  fireEvent.click(screen.getByRole("button", { name: "朗读消息" }));
  await vi.waitFor(() => expect(screen.getByRole("button", { name: /重试朗读/ })).toBeTruthy());
  expect(calls).toBe(2);
  expect(requested[0]).toBe("甲".repeat(1500));
  fireEvent.click(screen.getByRole("button", { name: /重试朗读/ }));
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "朗读消息" })).toBeTruthy());
  expect(calls).toBe(5);
  expect(requested.filter((chunk) => chunk === requested[0])).toHaveLength(1);
});

it("gives new messages exclusive audio focus", async () => {
  const audioBase64 = btoa("fake-mp3-bytes");
  const audios: FakeAudio[] = [];
  class FakeAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    pause = vi.fn();
    play = vi.fn().mockResolvedValue(undefined);
    constructor(public src?: string) { audios.push(this); }
  }
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("URL", {
    createObjectURL: () => `blob:${audios.length}`,
    revokeObjectURL: vi.fn(),
  } as unknown as typeof URL);
  const client = { call: vi.fn().mockResolvedValue({ audioBase64, mimeType: "audio/mpeg" }) } as unknown as RpcClient;
  render(<><SpeakButton client={client} text="第一条消息" /><SpeakButton client={client} text="第二条消息" /></>);
  fireEvent.click(screen.getAllByRole("button", { name: "朗读消息" })[0]);
  await vi.waitFor(() => expect(audios).toHaveLength(1));
  fireEvent.click(screen.getByRole("button", { name: "朗读消息" }));
  await vi.waitFor(() => expect(audios).toHaveLength(2));
  expect(audios[0].pause).toHaveBeenCalled();
  expect(audios[1].pause).not.toHaveBeenCalled();
});

const speechResult = { audioBase64: btoa("fake-mp3"), mimeType: "audio/mpeg" };

function deferredSpeech() {
  let resolve!: (result: typeof speechResult) => void;
  const promise = new Promise<typeof speechResult>((done) => { resolve = done; });
  return { promise, resolve };
}

function mockPlayback() {
  const audios: FakeAudio[] = [];
  class FakeAudio {
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    pause = vi.fn();
    play = vi.fn().mockResolvedValue(undefined);
    constructor(public src?: string) { audios.push(this); }
  }
  vi.stubGlobal("Audio", FakeAudio);
  const revoke = vi.fn();
  vi.stubGlobal("URL", {
    createObjectURL: () => `blob:${audios.length}`,
    revokeObjectURL: revoke,
  } as unknown as typeof URL);
  return { audios, revoke };
}

it("cancels during synthesis and ignores the late response after restarting", async () => {
  const { audios } = mockPlayback();
  const pending = deferredSpeech();
  const call = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(speechResult);
  const onError = vi.fn();
  render(<SpeakButton client={{ call } as unknown as RpcClient} text="第一条" onError={onError} />);
  fireEvent.click(screen.getByRole("button", { name: "朗读消息" }));
  const signal = call.mock.calls[0][2].signal as AbortSignal;
  fireEvent.click(screen.getByRole("button", { name: "正在合成语音" }));
  expect(signal.aborted).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "朗读消息" }));
  await screen.findByRole("button", { name: "停止朗读" });
  await act(async () => pending.resolve(speechResult));
  expect(audios).toHaveLength(1);
  expect(audios[0].pause).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});

it.each(["text", "client"])("cancels pending speech when the %s changes", async (changed) => {
  const { audios } = mockPlayback();
  const pending = deferredSpeech();
  const client = { call: vi.fn().mockReturnValue(pending.promise) } as unknown as RpcClient;
  const onError = vi.fn();
  const view = render(<SpeakButton client={client} text="原消息" onError={onError} />);
  fireEvent.click(screen.getByRole("button", { name: "朗读消息" }));
  view.rerender(<SpeakButton
    client={changed === "client" ? { call: vi.fn() } as unknown as RpcClient : client}
    text={changed === "text" ? "新消息" : "原消息"}
    onError={onError}
  />);
  await act(async () => pending.resolve(speechResult));
  expect(audios).toHaveLength(0);
  expect(onError).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "朗读消息" })).toBeTruthy();
});

it("does not start audio or further chunks after unmount", async () => {
  const { audios } = mockPlayback();
  const pending = deferredSpeech();
  const call = vi.fn().mockReturnValue(pending.promise);
  const view = render(<SpeakButton client={{ call } as unknown as RpcClient} text={"长文".repeat(2000)} />);
  fireEvent.click(screen.getByRole("button", { name: "朗读消息" }));
  view.unmount();
  await act(async () => pending.resolve(speechResult));
  expect(audios).toHaveLength(0);
  expect(call).toHaveBeenCalledTimes(1);
});

it("waits for playback before requesting the next chunk and shows synthesis progress", async () => {
  const { audios, revoke } = mockPlayback();
  const pending = deferredSpeech();
  const call = vi.fn().mockResolvedValueOnce(speechResult).mockReturnValueOnce(pending.promise);
  const text = `${"甲".repeat(1499)}。${"乙".repeat(40)}`;
  render(<SpeakButton client={{ call } as unknown as RpcClient} text={text} />);
  fireEvent.click(screen.getByRole("button", { name: "朗读消息" }));
  await screen.findByRole("button", { name: "停止朗读（1/2）" });
  expect(call).toHaveBeenCalledTimes(1);
  await act(async () => audios[0].onended?.());
  expect(screen.getByRole("button", { name: "正在合成语音（2/2）" })).toBeTruthy();
  expect(call).toHaveBeenCalledTimes(2);
  expect(revoke).toHaveBeenCalledWith("blob:0");
  await act(async () => pending.resolve(speechResult));
  await screen.findByRole("button", { name: "停止朗读（2/2）" });
  await act(async () => audios[1].onended?.());
  expect(screen.getByRole("button", { name: "朗读消息" })).toBeTruthy();
  expect(call.mock.calls.map(([, params]) => params.text).join("")).toBe(text);
});
