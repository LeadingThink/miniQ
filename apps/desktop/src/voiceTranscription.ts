import type { RpcClient } from "./rpc";
import { bytesToBase64, encodeVoiceWav } from "./voiceAudio";

// The 2-second timer fires just before the final audio callback on some devices.
// Allow that first snapshot instead of delaying the first text to 4 seconds.
const PREVIEW_SECONDS = 1.5;
const SEGMENT_SECONDS = 8;
interface Segment {
  chunks: Float32Array[];
  samples: number;
  silence: number;
  closed: boolean;
  text: string;
  recognized: number;
}
export interface VoicePreview {
  phase: "starting" | "recording" | "transcribing" | "failed";
  text: string;
  delayed?: boolean;
  error?: string;
}

/** Bounded, revisable previews; the final pass receives the complete recording. */
export class VoiceTranscription {
  private segments: Segment[] = [];
  private pending: Promise<void> | null = null;
  private finishing = false;
  private abort = new AbortController();
  private retryAt = 0;
  private failures = 0;
  constructor(private client: RpcClient, readonly sampleRate: number,
    private update: (text: string, delayed: boolean) => void) {}
  get duration() { return this.segments.reduce((total, segment) => total + segment.samples, 0) / this.sampleRate; }
  get text() { return joinVoiceSegments(this.segments.map((segment) => segment.text)); }

  append(samples: Float32Array) {
    if (this.finishing || this.abort.signal.aborted || !samples.length) return;
    let segment = this.segments.at(-1);
    if (!segment || segment.closed) {
      segment = { chunks: [], samples: 0, silence: 0, closed: false, text: "", recognized: 0 };
      this.segments.push(segment);
    }
    segment.chunks.push(samples); segment.samples += samples.length;
    const power = samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length;
    // Silence only selects a phrase boundary; no audio is discarded or filtered.
    segment.silence = power < 0.000064 ? segment.silence + samples.length : 0;
    segment.closed = segment.samples >= SEGMENT_SECONDS * this.sampleRate ||
      (segment.samples >= PREVIEW_SECONDS * this.sampleRate && segment.silence >= 0.5 * this.sampleRate);
  }

  preview(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.finishing || this.abort.signal.aborted || Date.now() < this.retryAt) return Promise.resolve();
    const segment = this.segments.find((value) => value.samples > value.recognized &&
      value.samples >= (value.closed ? 0.5 : PREVIEW_SECONDS) * this.sampleRate);
    if (!segment) return Promise.resolve();
    const samples = segment.samples;
    const chunks = [...segment.chunks];
    this.pending = this.request(chunks, true).then((text) => {
      if (this.abort.signal.aborted) return;
      segment.text = text; segment.recognized = samples;
      this.failures = 0; this.retryAt = 0;
      this.update(this.text, false);
    }).catch(() => {
      if (this.abort.signal.aborted) return;
      this.retryAt = Date.now() + Math.min(16_000, 4000 * ++this.failures);
      this.update(this.text, true);
    }).finally(() => {
      this.pending = null;
      // Catch up complete phrases without queuing every intermediate snapshot.
      if (segment.closed && segment.recognized === samples && !this.finishing) void this.preview();
    });
    return this.pending;
  }

  async finish(): Promise<string> {
    this.finishing = true;
    await this.pending;
    this.abort.signal.throwIfAborted();
    return this.request(this.segments.flatMap((segment) => segment.chunks), false);
  }
  cancel() { this.abort.abort(); this.segments = []; }
  private async request(chunks: Float32Array[], preview: boolean): Promise<string> {
    const wav = encodeVoiceWav(chunks, this.sampleRate);
    const response = await this.client.call<{ text: string }>("voice.transcribe", {
      audioBase64: bytesToBase64(wav), filename: "record.wav", preview,
    }, { signal: this.abort.signal, timeoutMs: preview ? 20_000 : 390_000 });
    if (typeof response.text !== "string") throw new Error("语音识别响应无效");
    return response.text.trim();
  }
}

function joinVoiceSegments(segments: string[]): string {
  return segments.filter(Boolean).reduce((text, next) => {
    // Repetition may be intentional speech; never deduplicate matching words.
    const separator = text && !/\s$/u.test(text) && /^[\p{Script=Latin}\p{N}]/u.test(next) ? " " : "";
    return text + separator + next;
  }, "");
}
