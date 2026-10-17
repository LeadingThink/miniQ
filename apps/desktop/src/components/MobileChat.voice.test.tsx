// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MobileChat } from "./MobileChat";
import { startVoiceCapture } from "../voiceCapture";
import { appleSpeechAvailable, startAppleSpeech } from "../appleSpeech";
vi.mock("../voiceCapture", () => ({ startVoiceCapture: vi.fn() }));
vi.mock("../appleSpeech", () => ({ appleSpeechAvailable: vi.fn(async () => false), startAppleSpeech: vi.fn() }));
vi.mock("./Md", () => ({ Md: ({ children }: { children: string }) => <div>{children}</div> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.mocked(appleSpeechAvailable).mockResolvedValue(false); localStorage.clear(); });
it("shares the model catalog, preserves a draft and posts voice directly before sending text", async () => {
  let samples!: (samples: Float32Array, rate: number) => void;
  const stop = vi.fn();
  vi.mocked(startVoiceCapture).mockImplementation(async (_signal, callback) => { samples = callback; return { stop }; });
  const fetch = vi.fn(async (url: unknown) => new Response(JSON.stringify(String(url).endsWith("/models")
    ? { data: [{ id: "chat-model", model_type: "chat" }, { id: "grok-transcribe", model_type: "audio" }] }
    : { text: "语音文字" })));
  vi.stubGlobal("fetch", fetch); render(<MobileChat apiKey="phone-key" onBack={() => {}} />);
  const mic = await screen.findByRole("button", { name: "语音输入" });
  expect(fetch).toHaveBeenCalledTimes(1);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox"); fireEvent.change(input, { target: { value: "已有草稿" } }); input.setSelectionRange(4, 4);
  await act(async () => fireEvent.click(mic)); act(() => samples(new Float32Array(16000), 16000));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "发送" }).disabled).toBe(true);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "结束录音" })));
  await waitFor(() => expect(input.value).toBe("已有草稿语音文字"));
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    "https://oneapi.zaiwenai.com/v1/models", "https://oneapi.zaiwenai.com/v1/audio/transcriptions"]);
  expect(stop).toHaveBeenCalled();
});
it("uses iOS on-device speech recognition without calling cloud ASR when available", async () => {
  let samples!: (samples: Float32Array, rate: number) => void;
  const stop = vi.fn();
  vi.mocked(appleSpeechAvailable).mockResolvedValue(true);
  vi.mocked(startAppleSpeech).mockResolvedValue({
    append: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue("本机语音文字"),
    cancel: vi.fn(),
  });
  vi.mocked(startVoiceCapture).mockImplementation(async (_signal, callback) => { samples = callback; return { stop }; });
  const fetch = vi.fn(async (_url: unknown) => new Response(JSON.stringify({ data: [{ id: "chat-model", model_type: "chat" }] })));
  vi.stubGlobal("fetch", fetch);
  render(<MobileChat apiKey="phone-key" onBack={() => {}} />);
  const mic = await screen.findByRole("button", { name: "语音输入" });
  const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  await act(async () => fireEvent.click(mic));
  act(() => samples(new Float32Array(16000), 16000));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "结束录音" })));
  await waitFor(() => expect(input.value).toBe("本机语音文字"));
  expect(startAppleSpeech).toHaveBeenCalledOnce();
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual(["https://oneapi.zaiwenai.com/v1/models"]);
});
