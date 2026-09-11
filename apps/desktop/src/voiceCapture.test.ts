// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { startVoiceCapture } from "./voiceCapture";

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const track = { stop: vi.fn(), onended: null };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const processor = { ...node(), onaudioprocess: null as null | ((event: unknown) => void) };
  const context = {
    state: "suspended", sampleRate: 48_000, destination: {},
    close: vi.fn(async () => { context.state = "closed"; }),
    resume: vi.fn(async () => { context.state = "running"; }),
    createMediaStreamSource: vi.fn(node), createScriptProcessor: vi.fn(() => processor),
    createGain: vi.fn(() => ({ ...node(), gain: { value: 1 } })),
  };
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  vi.stubGlobal("AudioContext", class { constructor() { return context; } });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  return { track, stream, context, processor, getUserMedia, abort: new AbortController() };
}

it("stops a microphone granted after permission was cancelled", async () => {
  const fixture = setup();
  let grant!: (value: unknown) => void;
  fixture.getUserMedia.mockImplementation(() => new Promise(resolve => { grant = resolve; }));
  const pending = startVoiceCapture(fixture.abort.signal, vi.fn(), vi.fn());
  fixture.abort.abort(); grant(fixture.stream);
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(fixture.track.stop).toHaveBeenCalledTimes(1);
  expect(fixture.context.createMediaStreamSource).not.toHaveBeenCalled();
});

it("does not connect audio nodes after cancellation during context resume", async () => {
  const fixture = setup();
  let resumed!: () => void;
  fixture.context.resume.mockImplementation(() => new Promise(resolve => { resumed = resolve; }));
  const pending = startVoiceCapture(fixture.abort.signal, vi.fn(), vi.fn());
  await vi.waitFor(() => expect(fixture.context.resume).toHaveBeenCalled());
  fixture.abort.abort(); resumed();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(fixture.track.stop).toHaveBeenCalledTimes(1);
  expect(fixture.context.createMediaStreamSource).not.toHaveBeenCalled();
});

it("copies captured samples and releases microphone and nodes idempotently", async () => {
  const fixture = setup(); const receive = vi.fn(); const ended = vi.fn();
  const capture = await startVoiceCapture(fixture.abort.signal, receive, ended);
  const original = new Float32Array([0.1, 0.2]);
  fixture.processor.onaudioprocess!({ inputBuffer: { getChannelData: () => original } });
  expect(receive).toHaveBeenCalledWith(original, 48_000);
  expect(receive.mock.calls[0][0]).not.toBe(original);
  capture.stop(); capture.stop(); fixture.abort.abort();
  expect(fixture.track.stop).toHaveBeenCalledTimes(1);
  expect(fixture.processor.disconnect).toHaveBeenCalledTimes(1);
  expect(fixture.processor.onaudioprocess).toBeNull();
  expect(ended).not.toHaveBeenCalled();
});
