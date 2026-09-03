import { describe, expect, it } from "vitest";
import { encodeVoiceWav, insertTranscript, VOICE_SAMPLE_RATE } from "./voiceAudio";

describe("voice audio", () => {
  it("encodes microphone samples as a 16 kHz mono PCM WAV", () => {
    const wav = encodeVoiceWav([new Float32Array(48_000).fill(0.25)], 48_000);
    const view = new DataView(wav.buffer);

    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(VOICE_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(VOICE_SAMPLE_RATE * 2);
  });

  it("inserts a transcript at the recorded selection", () => {
    expect(insertTranscript("请修复这个问题", "认真检查", { start: 1, end: 3 })).toEqual({
      value: "请认真检查这个问题",
      cursor: 5,
    });
  });
});
