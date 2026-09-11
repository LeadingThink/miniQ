// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../rpc";
import { startVoiceCapture } from "../voiceCapture";
import { ComposerCard } from "./Composer";

vi.mock("../voiceCapture", () => ({ startVoiceCapture: vi.fn() }));
let samples: (audio: Float32Array, rate: number) => void;
let signal: AbortSignal;
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(startVoiceCapture).mockImplementation(async (abort, callback) => {
    samples = callback; signal = abort; return { stop: vi.fn() };
  });
});
afterEach(() => { cleanup(); localStorage.clear(); vi.useRealTimers(); vi.clearAllMocks(); });
function setup() {
  const call = vi.fn().mockResolvedValue({ text: "识别文字" });
  const props = { busy: false, placeholder: "消息", draftKey: "voice-a", client: { call } as unknown as RpcClient, onSend: vi.fn(async () => true) };
  const view = render(<ComposerCard {...props} />);
  return { props, view, call };
}
async function record() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "语音输入" })); });
  act(() => samples(new Float32Array(32_000).fill(0.1), 16_000));
  await act(async () => { vi.advanceTimersByTime(2000); });
}

it("previews separately and blocks send until the final transcript is inserted", async () => {
  const { props } = setup(); const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "原有草稿" } });
  input.setSelectionRange(4, 4); await record();
  expect(screen.getByLabelText("语音转录预览").textContent).toContain("识别文字");
  expect(input.value).toBe("原有草稿");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "发送消息" }).disabled).toBe(true);
  fireEvent.keyDown(input, { key: "Enter" }); expect(props.onSend).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "结束录音" })); });
  expect(input.value).toBe("原有草稿识别文字");
  expect(screen.queryByLabelText("语音转录预览")).toBeNull();
});

it("preserves draft edits made during recording instead of replacing a stale selection", async () => {
  setup(); const input = screen.getByRole<HTMLTextAreaElement>("textbox");
  fireEvent.change(input, { target: { value: "最初草稿" } }); input.setSelectionRange(0, 4);
  await record(); fireEvent.change(input, { target: { value: "已经编辑好的内容" } });
  input.setSelectionRange(8, 8);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "结束录音" })); });
  expect(input.value).toBe("已经编辑好的内容识别文字");
});

it("clears voice state and ignores a late result after changing sessions", async () => {
  const { props, view, call } = setup(); await record();
  let resolve!: (value: { text: string }) => void;
  call.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "结束录音" })); });
  view.rerender(<ComposerCard {...props} draftKey="voice-b" />);
  expect(signal.aborted).toBe(true);
  await act(async () => resolve({ text: "旧会话的转录" }));
  expect(screen.queryByLabelText("语音转录预览")).toBeNull();
  expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe("");
});
