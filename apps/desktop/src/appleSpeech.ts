import { Channel, invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./runtime";
import { throwIfAborted } from "./abortSignal";

export interface LocalSpeech {
  append(samples: Float32Array): Promise<void>;
  finish(): Promise<string>;
  cancel(): void;
}
interface SpeechEvent { id: string; kind: "ready" | "partial" | "final" | "error"; text: string }
export function speechLanguage(): string { return navigator.language || "zh-CN"; }
export async function appleSpeechAvailable(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try { return await invoke<boolean>("apple_speech_available", { language: speechLanguage() }); }
  catch { return false; }
}

export async function startAppleSpeech(rate: number, partial: (text: string) => void,
  failed: (error: Error) => void, signal: AbortSignal): Promise<LocalSpeech> {
  throwIfAborted(signal);
  const id = crypto.randomUUID();
  let closed = false;
  let started = false;
  let finalResolve: ((value: string) => void) | undefined;
  let finalReject: ((error: Error) => void) | undefined;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const cancelNative = () => { void invoke("apple_speech_cancel", { id }).catch(() => {}); };
  const cleanup = () => { closed = true; clearTimeout(timer); signal.removeEventListener("abort", abort); cancelNative(); };
  const fail = (error: Error) => {
    if (closed) return;
    cleanup(); readyReject(error); finalReject?.(error);
    if (started) failed(error);
  };
  const abort = () => fail(new DOMException("Request cancelled", "AbortError"));
  const onEvent = new Channel<SpeechEvent>();
  onEvent.onmessage = (event) => {
    if (closed || event.id !== id) return;
    if (event.kind === "ready") { clearTimeout(timer); started = true; readyResolve(); }
    else if (event.kind === "partial") partial(event.text);
    else if (event.kind === "final") {
      if (!finalResolve) { fail(new Error("local-ended-early")); return; }
      cleanup(); finalResolve(event.text);
    } else fail(new Error("local-recognition-failed"));
  };
  signal.addEventListener("abort", abort, { once: true });
  timer = setTimeout(() => fail(new Error("local-start-timeout")), 20_000);
  // Register the channel before starting. A cancelled slow start must not revive a session.
  void invoke("apple_speech_start", { id, language: speechLanguage(), sampleRate: rate, onEvent })
    .then(() => { if (closed) cancelNative(); }).catch(() => fail(new Error("local-start-failed")));
  await ready;
  throwIfAborted(signal);
  return {
    async append(samples) {
      if (closed) throw new Error("local-session-ended");
      let appendTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          invoke("apple_speech_append", { id, samples: Array.from(samples) }),
          new Promise<never>((_, reject) => {
            appendTimer = setTimeout(() => reject(new Error("local-append-timeout")), 3000);
          }),
        ]);
      } catch (error) {
        fail(new Error("local-append-failed"));
        throw error;
      } finally { clearTimeout(appendTimer); }
    },
    finish() {
      if (closed) return Promise.reject(new Error("local-session-ended"));
      return new Promise<string>((resolve, reject) => {
        finalResolve = resolve; finalReject = reject;
        timer = setTimeout(() => fail(new Error("local-finish-timeout")), 10_000);
        void invoke("apple_speech_finish", { id }).catch(() => fail(new Error("local-finish-failed")));
      });
    },
    cancel() { fail(new DOMException("Request cancelled", "AbortError")); },
  };
}
