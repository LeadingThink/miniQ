// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { SpeakButton } from "./SpeakButton";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(
  call: (method: string, params?: unknown) => Promise<unknown>,
  onError: (message: string) => void = () => undefined,
) {
  const client = { call: vi.fn(call) } as unknown as RpcClient;
  render(<SpeakButton client={client} text="你好，欢迎使用在问。" onError={onError} />);
  return client as unknown as { call: ReturnType<typeof vi.fn> };
}

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
