import type { RpcClient } from "./rpc";
import { VoiceTranscription, type VoiceTranscriber } from "./voiceTranscription";
import { startAppleSpeech, type LocalSpeech } from "./appleSpeech";
import { throwIfAborted } from "./abortSignal";

/** One capture and one final insertion. API buffering is inert until fallback. */
export class AutomaticVoice {
  private api: VoiceTranscription;
  private local?: LocalSpeech;
  private mode: "local" | "api";
  private queue: Float32Array[] = [];
  private pumping?: Promise<void>;
  private ready: Promise<void>;
  private abort = new AbortController();
  private finishing = false;
  private lastText = "";

  constructor(client: RpcClient | VoiceTranscriber, rate: number,
    private readonly update: (text: string, delayed: boolean) => void,
    model?: string, preferLocal = false) {
    this.mode = preferLocal ? "local" : "api";
    this.api = new VoiceTranscription(client, rate, (text, delayed) => {
      if (!this.abort.signal.aborted && this.mode === "api") {
        this.lastText = text; update(text, delayed);
      }
    }, model);
    this.ready = preferLocal ? startAppleSpeech(rate, (text) => {
      if (!this.abort.signal.aborted && this.mode === "local") {
        this.lastText = text; update(text, false);
      }
    }, () => this.fallback(), this.abort.signal).then((local) => {
      if (this.abort.signal.aborted || this.mode !== "local") { local.cancel(); return; }
      this.local = local;
      return this.pump();
    }).catch(() => this.fallback()) : Promise.resolve();
  }
  get duration() { return this.api.duration; }
  get text() { return this.lastText; }
  get needsFinalCorrection() { return this.mode === "api"; }
  append(samples: Float32Array) {
    if (this.finishing || this.abort.signal.aborted) return;
    this.api.append(samples);
    if (this.mode === "local") {
      this.queue.push(samples);
      if (this.local) void this.pump();
    }
  }
  preview() { return this.mode === "api" ? this.api.preview() : Promise.resolve(); }
  async finish(): Promise<string> {
    this.finishing = true;
    await this.ready;
    throwIfAborted(this.abort.signal);
    if (this.mode === "local" && this.local) {
      await this.pump();
      try {
        if (this.mode === "local") {
          const text = (await this.local.finish()).trim();
          throwIfAborted(this.abort.signal);
          if (text) return text;
        }
      } catch { /* A complete API pass replaces local partials. */ }
      this.fallback();
    }
    throwIfAborted(this.abort.signal);
    const text = await this.api.finish();
    throwIfAborted(this.abort.signal);
    return text;
  }
  cancel() {
    this.abort.abort(); this.local?.cancel(); this.api.cancel(); this.queue = [];
  }
  private fallback() {
    if (this.abort.signal.aborted || this.mode === "api") return;
    this.mode = "api";
    this.queue = [];
    this.local?.cancel();
    // No audio, keys or transcript is recorded in diagnostics.
    console.info("[voice] local recognition unavailable; using API");
    if (this.finishing) this.update(this.lastText, true);
    if (!this.finishing) void this.api.preview();
  }
  private pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    this.pumping = (async () => {
      while (this.queue.length && this.local && this.mode === "local" && !this.abort.signal.aborted) {
        const samples = this.queue.shift()!;
        await this.local.append(samples);
      }
    })().catch(() => this.fallback()).finally(() => { this.pumping = undefined; });
    return this.pumping;
  }
}
