import { MOBILE_API_BASE_URL } from "./mobileChatData";
import type { VoiceTranscriber } from "./voiceTranscription";
import { throwIfAborted } from "./abortSignal";

const MODELS = ["grok-transcribe", "sencevoice-small"];
export async function fetchMobileVoiceCapabilities(key: string, signal?: AbortSignal) {
  if (!key.trim()) return { transcribe: false, transcribeModel: null };
  const body = await request(key, "/models", {}, signal, 15_000);
  const transcribeModel = mobileVoiceModel(body);
  return { transcribe: transcribeModel !== null, transcribeModel };
}

export function mobileVoiceModel(value: unknown): string | null {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const models = Array.isArray(body.data) ? body.data.flatMap((entry: unknown) =>
    entry && typeof entry === "object" && "id" in entry ? [entry.id] : []) : [];
  return MODELS.find((model) => models.includes(model)) ?? null;
}

/** Uses the phone's service key, never the selected computer's RPC or credentials. */
export function createMobileVoiceTranscriber(key: string, model = "grok-transcribe"): VoiceTranscriber {
  return async (audio, preview, signal) => {
    if (!key.trim()) throw new Error("请先在手机设置中保存 API Key");
    if (audio.byteLength <= 44 || audio.byteLength > 12 * 1024 * 1024) throw new Error("录音为空或超过 12 MB");
    if (!MODELS.includes(model)) throw new Error("语音模型不可用");
    throwIfAborted(signal);
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "record.wav");
    form.append("model", model); form.append("response_format", "json");
    for (let attempt = 0; ; attempt++) {
      try {
        const body = await request(key, "/audio/transcriptions", { method: "POST", body: form }, signal, preview ? 20_000 : 120_000);
        if (typeof body.text !== "string") throw new VoiceRequestError("语音服务响应无效", false);
        return body.text.trim();
      } catch (error) {
        throwIfAborted(signal);
        if (preview || attempt >= 2 || (error instanceof VoiceRequestError && !error.retryable)) throw error;
        await waitForRetry(attempt === 0 ? 500 : 1500, signal);
      }
    }
  };
}

async function request(key: string, path: string, init: RequestInit, signal: AbortSignal | undefined, timeout: number) {
  if (!key.trim()) throw new Error("请先在手机设置中保存 API Key");
  const abort = new AbortController();
  const forward = () => abort.abort(signal?.reason);
  if (signal?.aborted) forward(); else signal?.addEventListener("abort", forward, { once: true });
  const timer = setTimeout(() => abort.abort(new Error("语音服务连接超时，请重试")), timeout);
  try {
    const response = await fetch(`${MOBILE_API_BASE_URL}${path}`, {
      ...init, headers: { Authorization: `Bearer ${key.trim()}` }, signal: abort.signal,
      redirect: "error",
    });
    if (!response.ok) {
      // Never surface a provider body that might echo headers or audio.
      if (response.status === 401 || response.status === 403) throw new VoiceRequestError("语音识别鉴权失败，请检查手机上的 API Key", false);
      throw new VoiceRequestError(`语音服务暂时不可用（${response.status}），请重试`, response.status === 429 || response.status >= 500);
    }
    const body: unknown = await response.json();
    throwIfAborted(abort.signal);
    if (!body || typeof body !== "object") throw new VoiceRequestError("语音服务响应无效", false);
    return body as Record<string, unknown>;
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", forward); }
}

class VoiceRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) { super(message); }
}

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}
