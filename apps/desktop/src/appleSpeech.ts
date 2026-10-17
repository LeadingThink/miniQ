import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { Channel, invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./runtime";
import { throwIfAborted } from "./abortSignal";

export interface LocalSpeech {
  append(samples: Float32Array): Promise<void>;
  finish(): Promise<string>;
  cancel(): void;
}
interface SpeechEvent { id: string; kind: "ready" | "partial" | "final" | "error"; text: string }
interface MiniqSpeechPlugin {
  available(options: { language: string }): Promise<{ available: boolean }>;
  start(options: { id: string; language: string; sampleRate: number }): Promise<void>;
  append(options: { id: string; samples: number[] }): Promise<void>;
  finish(options: { id: string }): Promise<void>;
  cancel(options: { id: string }): Promise<void>;
  addListener(event: "speechEvent", listener: (event: SpeechEvent) => void): Promise<PluginListenerHandle>;
}
let cachedIosSpeech: MiniqSpeechPlugin | undefined;
function getIosSpeech(): MiniqSpeechPlugin {
  cachedIosSpeech ??= registerPlugin<MiniqSpeechPlugin>("MiniqSpeech");
  return cachedIosSpeech;
}
function isIosNativeRuntime(): boolean {
  try { return Capacitor.getPlatform() === "ios"; } catch { return false; }
}
export function speechLanguage(): string { return navigator.language || "zh-CN"; }
export async function appleSpeechAvailable(): Promise<boolean> {
  if (isTauriRuntime()) {
    try { return await invoke<boolean>("apple_speech_available", { language: speechLanguage() }); }
    catch { return false; }
  }
  if (isIosNativeRuntime()) {
    try { return Boolean((await getIosSpeech().available({ language: speechLanguage() }))?.available); }
    catch { return false; }
  }
  return false;
}

export async function startAppleSpeech(rate: number, partial: (text: string) => void,
  failed: (error: Error) => void, signal: AbortSignal): Promise<LocalSpeech> {
  throwIfAborted(signal);
  const id = crypto.randomUUID();
  const useIosPlugin = !isTauriRuntime() && isIosNativeRuntime();
  let closed = false;
  let started = false;
  let finalResolve: ((value: string) => void) | undefined;
  let finalReject: ((error: Error) => void) | undefined;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let listener: PluginListenerHandle | undefined;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const cancelNative = () => {
    if (useIosPlugin) void getIosSpeech().cancel({ id }).catch(() => {});
    else void invoke("apple_speech_cancel", { id }).catch(() => {});
  };
  const cleanup = () => {
    closed = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    void listener?.remove().catch(() => {});
    listener = undefined;
    cancelNative();
  };
  const fail = (error: Error) => {
    if (closed) return;
    cleanup(); readyReject(error); finalReject?.(error);
    if (started) failed(error);
  };
  const abort = () => fail(new DOMException("Request cancelled", "AbortError"));
  const handleEvent = (event: SpeechEvent) => {
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
  if (useIosPlugin) {
    const iosSpeech = getIosSpeech();
    // Register the listener before starting. A cancelled slow start must not revive a session.
    void iosSpeech.addListener("speechEvent", handleEvent)
      .then((handle) => {
        if (closed) { void handle.remove().catch(() => {}); return; }
        listener = handle;
        return iosSpeech.start({ id, language: speechLanguage(), sampleRate: rate });
      })
      .then(() => { if (closed) cancelNative(); })
      .catch(() => fail(new Error("local-start-failed")));
  } else {
    const onEvent = new Channel<SpeechEvent>();
    onEvent.onmessage = handleEvent;
    // Register the channel before starting. A cancelled slow start must not revive a session.
    void invoke("apple_speech_start", { id, language: speechLanguage(), sampleRate: rate, onEvent })
      .then(() => { if (closed) cancelNative(); }).catch(() => fail(new Error("local-start-failed")));
  }
  await ready;
  throwIfAborted(signal);
  const appendNative = (samples: Float32Array) => useIosPlugin
    ? getIosSpeech().append({ id, samples: Array.from(samples) })
    : invoke("apple_speech_append", { id, samples: Array.from(samples) });
  const finishNative = () => useIosPlugin
    ? getIosSpeech().finish({ id })
    : invoke("apple_speech_finish", { id });
  return {
    async append(samples) {
      if (closed) throw new Error("local-session-ended");
      let appendTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          appendNative(samples),
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
        void finishNative().catch(() => fail(new Error("local-finish-failed")));
      });
    },
    cancel() { fail(new DOMException("Request cancelled", "AbortError")); },
  };
}
