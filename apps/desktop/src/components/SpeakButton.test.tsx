// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  const text = `第一段。${"😀".repeat(5)}第二段！第三段？`;
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
  expect(client.call).toHaveBeenCalledWith("voice.speak", { text: "你好，欢迎使用在问。" });
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
  const client = setup(() => {
    calls += 1;
    if (calls === 2) return Promise.reject(new Error("temporary provider error"));
    return Promise.resolve({ audioBase64, mimeType: "audio/mpeg" });
  }, () => undefined, text);
  fireEvent.click(screen.getByRole("button", { name: "朗读消息" }));
  await vi.waitFor(() => expect(screen.getByRole("button", { name: /重试朗读/ })).toBeTruthy());
  expect(calls).toBe(2);
  fireEvent.click(screen.getByRole("button", { name: /重试朗读/ }));
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "朗读消息" })).toBeTruthy());
  expect(calls).toBe(4);
});
