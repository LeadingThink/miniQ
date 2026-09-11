// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { startVoiceCapture } from "../voiceCapture";
import { VoiceInput } from "./VoiceInput";

vi.mock("../voiceCapture", () => ({ startVoiceCapture: vi.fn() }));
let samples: (audio: Float32Array, rate: number) => void;
let captureSignal: AbortSignal;
const stop = vi.fn();
beforeEach(() => {
  vi.useFakeTimers(); stop.mockReset();
  vi.mocked(startVoiceCapture).mockImplementation(async (signal, callback) => { captureSignal = signal; samples = callback; return { stop }; });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
function setup(call = vi.fn().mockResolvedValue({ text: "实时文字" })) {
  const props = { client: { call } as unknown as RpcClient, onStart: vi.fn(), onPreview: vi.fn(), onTranscribed: vi.fn(), onError: vi.fn() };
  const view = render(<VoiceInput {...props} />);
  return { ...props, call, view };
}
async function record() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "语音输入" })); });
  act(() => samples(new Float32Array(32_000).fill(0.1), 16_000));
  await act(async () => { vi.advanceTimersByTime(2000); });
}

it("shows recognized text before stop, then commits exactly one final correction", async () => {
  const props = setup(vi.fn().mockResolvedValueOnce({ text: "临时内容" }).mockResolvedValueOnce({ text: "校正后的完整内容" }));
  await record();
  expect(props.onPreview).toHaveBeenCalledWith({ phase: "recording", text: "临时内容", delayed: false });
  expect(props.onTranscribed).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "结束录音" })); });
  expect(props.onTranscribed).toHaveBeenCalledExactlyOnceWith("校正后的完整内容");
  expect(stop).toHaveBeenCalled(); expect(props.onPreview).toHaveBeenLastCalledWith(null);
});

it("retains recognition for a retry without opening the microphone again", async () => {
  const props = setup(vi.fn().mockResolvedValueOnce({ text: "预览文字" }).mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ text: "恢复后的完整内容" }));
  await record();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "结束录音" })); });
  expect(props.onPreview).toHaveBeenLastCalledWith({ phase: "failed", text: "预览文字", error: "offline" });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重试语音识别" })); });
  expect(startVoiceCapture).toHaveBeenCalledTimes(1);
  expect(props.onTranscribed).toHaveBeenCalledExactlyOnceWith("恢复后的完整内容");
});

it("cancels an in-flight final response when the owning session unmounts", async () => {
  let resolve!: (value: { text: string }) => void;
  const props = setup(vi.fn().mockResolvedValueOnce({ text: "预览文字" })
    .mockImplementationOnce(() => new Promise((done) => { resolve = done; })));
  await record();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "结束录音" })); });
  props.view.unmount();
  expect(captureSignal.aborted).toBe(true);
  await act(async () => resolve({ text: "其他会话不应收到这段文字" }));
  expect(props.onTranscribed).not.toHaveBeenCalled();
});
