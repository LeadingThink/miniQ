export const VOICE_SAMPLE_RATE = 16_000;

function mergeSamples(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/** Resample microphone floats and encode a mono 16-bit PCM WAV. */
export function encodeVoiceWav(
  chunks: Float32Array[],
  inputSampleRate: number,
  outputSampleRate = VOICE_SAMPLE_RATE,
): Uint8Array {
  if (inputSampleRate <= 0 || outputSampleRate <= 0) {
    throw new Error("invalid audio sample rate");
  }
  const input = mergeSamples(chunks);
  const sampleCount = Math.floor((input.length * outputSampleRate) / inputSampleRate);
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, outputSampleRate, true);
  view.setUint32(28, outputSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, sampleCount * 2, true);

  const ratio = inputSampleRate / outputSampleRate;
  for (let index = 0; index < sampleCount; index += 1) {
    const sourcePosition = index * ratio;
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(leftIndex + 1, input.length - 1);
    const fraction = sourcePosition - leftIndex;
    const sample = input.length
      ? input[leftIndex] * (1 - fraction) + input[rightIndex] * fraction
      : 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export interface TextRange {
  start: number;
  end: number;
}

/** Insert speech without deleting text typed while transcription was running. */
export function insertTranscript(
  current: string,
  transcript: string,
  range: TextRange,
): { value: string; cursor: number } {
  const start = Math.max(0, Math.min(range.start, current.length));
  const end = Math.max(start, Math.min(range.end, current.length));
  const text = transcript.trim();
  const value = current.slice(0, start) + text + current.slice(end);
  return { value, cursor: start + text.length };
}
