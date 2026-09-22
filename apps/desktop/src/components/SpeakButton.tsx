import { LoaderCircle, Square, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RpcClient } from "../rpc";

/** Keep each request below the daemon/provider speech input limit. */
export const MAX_SPEECH_CHARS = 1500;

interface SpeakResponse {
  audioBase64: string;
  mimeType: string;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Split text without dropping Unicode characters. The splitter prefers a
 * sentence or paragraph boundary, but a single long sentence is split at the
 * exact provider limit. It is deliberately lazy at the caller: chunks are
 * requested one at a time while playback advances.
 */
export function splitTextForSpeech(text: string, maxChars = MAX_SPEECH_CHARS): string[] {
  const chars = Array.from(text);
  if (chars.length === 0 || chars.every((char) => /\s/u.test(char))) return [];
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error("speech chunk size must be a positive integer");
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < chars.length) {
    const hardEnd = Math.min(start + maxChars, chars.length);
    let end = hardEnd;
    if (hardEnd < chars.length) {
      for (let index = hardEnd; index > start; index -= 1) {
        const previous = chars[index - 1];
        if (previous === "\n" || /[。！？!?；;.!?]/u.test(previous)) {
          end = index;
          break;
        }
      }
    }
    chunks.push(chars.slice(start, end).join(""));
    start = end;
  }
  return chunks;
}

export function SpeakButton(props: {
  client: RpcClient;
  text: string;
  disabled?: boolean;
  onError?: (message: string) => void;
}) {
  const [status, setStatus] = useState<"idle" | "loading" | "playing" | "error">("idle");
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const chunksRef = useRef<string[]>([]);
  const failedChunkRef = useRef(0);
  const runTokenRef = useRef(0);
  const resolvePlaybackRef = useRef<(() => void) | null>(null);

  const clearAudio = (expectedAudio?: HTMLAudioElement, expectedUrl?: string) => {
    if (expectedAudio && audioRef.current !== expectedAudio) return;
    if (expectedUrl && urlRef.current !== expectedUrl) return;
    resolvePlaybackRef.current?.();
    resolvePlaybackRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
    }
    audioRef.current = null;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  };

  const stop = () => {
    runTokenRef.current += 1;
    clearAudio();
    chunksRef.current = [];
    failedChunkRef.current = 0;
    setProgress({ current: 0, total: 0 });
    setStatus("idle");
  };

  useEffect(() => () => {
    // Unmount cleanup must invalidate in-flight RPC/audio work without
    // enqueueing state updates on a component that no longer exists.
    runTokenRef.current += 1;
    clearAudio();
  }, []);
  useEffect(() => {
    // A message can be replaced in place while a timeline row remains
    // mounted. Never let audio from the previous message continue into it.
    if (status !== "idle") stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.text, props.client]);

  const playAudio = async (audio: HTMLAudioElement, token: number) => {
    await new Promise<void>((resolve, reject) => {
      resolvePlaybackRef.current = resolve;
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("音频播放失败"));
      void audio.play().catch(reject);
    });
    return token === runTokenRef.current;
  };

  const speak = async (retry = false) => {
    if ((status !== "idle" && status !== "error") || props.disabled) return;
    const content = props.text;
    if (!content.trim()) {
      props.onError?.("没有可朗读的文本");
      return;
    }
    const chunks = retry && chunksRef.current.length > 0
      ? chunksRef.current
      : splitTextForSpeech(content);
    chunksRef.current = chunks;
    const firstChunk = retry ? failedChunkRef.current : 0;
    const token = ++runTokenRef.current;
    setProgress({ current: firstChunk, total: chunks.length });
    setStatus("loading");
    for (let index = firstChunk; index < chunks.length; index += 1) {
      if (token !== runTokenRef.current) return;
      setProgress({ current: index, total: chunks.length });
      let chunkAudio: HTMLAudioElement | undefined;
      let chunkUrl: string | undefined;
      try {
        const result = await props.client.call<SpeakResponse>("voice.speak", {
          text: chunks[index],
        });
        if (token !== runTokenRef.current) return;
        if (typeof result.audioBase64 !== "string" || !result.audioBase64) {
          throw new Error("语音合成响应无效");
        }
        const bytes = base64ToBytes(result.audioBase64);
        const mime = result.mimeType.startsWith("audio/") ? result.mimeType : "audio/mpeg";
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime });
        chunkUrl = URL.createObjectURL(blob);
        urlRef.current = chunkUrl;
        const audio = new Audio(chunkUrl);
        chunkAudio = audio;
        audioRef.current = audio;
        setStatus("playing");
        const completed = await playAudio(audio, token);
        clearAudio(chunkAudio, chunkUrl);
        if (!completed) return;
      } catch (cause) {
        // An older run may finish after the user starts another chunk/run.
        // It must never revoke or pause the newer run's audio.
        if (token !== runTokenRef.current) {
          if (chunkAudio || chunkUrl) clearAudio(chunkAudio, chunkUrl);
          return;
        }
        clearAudio();
        failedChunkRef.current = index;
        setProgress({ current: index, total: chunks.length });
        setStatus("error");
        props.onError?.(friendlyError(cause));
        return;
      }
    }
    if (token === runTokenRef.current) {
      chunksRef.current = [];
      setProgress({ current: chunks.length, total: chunks.length });
      setStatus("idle");
    }
  };

  const progressLabel = progress.total > 1 && status !== "idle"
    ? `（${Math.min(progress.current + 1, progress.total)}/${progress.total}）`
    : "";
  const label = status === "playing"
    ? `停止朗读${progressLabel}`
    : status === "loading"
      ? `正在合成语音${progressLabel}`
      : status === "error"
        ? `重试朗读${progressLabel}`
        : "朗读消息";
  return (
    <button
      type="button"
      className="msg-action"
      title={label}
      aria-label={label}
      aria-pressed={status === "playing"}
      aria-busy={status === "loading"}
      disabled={props.disabled || !props.text.trim()}
      onClick={() => {
        if (status === "playing" || status === "loading") stop();
        else void speak(status === "error");
      }}
    >
      {status === "loading" ? (
        <LoaderCircle className="spin" size={15} />
      ) : status === "playing" ? (
        <Square size={13} fill="currentColor" />
      ) : (
        <Volume2 size={15} />
      )}
    </button>
  );
}

function friendlyError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes("not configured")) return "请先在设置中配置模型服务和 API Key";
  if (message.includes("401") || message.includes("403")) return "语音合成鉴权失败，请检查 API Key";
  if (message.includes("character limit")) return "这条消息太长，暂不支持完整朗读";
  if (message.includes("unsupported voice")) return "当前语音服务音色不可用";
  return message.replace(/ \(code -?\d+\)$/, "");
}
