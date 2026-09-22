import { LoaderCircle, Square, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RpcClient } from "../rpc";

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

export function SpeakButton(props: {
  client: RpcClient;
  text: string;
  disabled?: boolean;
  onError?: (message: string) => void;
}) {
  const [status, setStatus] = useState<"idle" | "loading" | "playing">("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const stop = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    setStatus("idle");
  };

  useEffect(() => stop, []);

  const speak = async () => {
    if (status !== "idle" || props.disabled) return;
    const content = props.text.trim();
    if (!content) {
      props.onError?.("没有可朗读的文本");
      return;
    }
    setStatus("loading");
    try {
      const result = await props.client.call<SpeakResponse>("voice.speak", {
        text: content,
      });
      if (typeof result.audioBase64 !== "string" || !result.audioBase64) {
        throw new Error("语音合成响应无效");
      }
      const bytes = base64ToBytes(result.audioBase64);
      const mime = result.mimeType.startsWith("audio/") ? result.mimeType : "audio/mpeg";
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime });
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      setStatus("playing");
      audio.onended = () => stop();
      audio.onerror = () => {
        stop();
        props.onError?.("音频播放失败");
      };
      await audio.play();
    } catch (cause) {
      stop();
      props.onError?.(friendlyError(cause));
    }
  };

  const label =
    status === "playing" ? "停止朗读" : status === "loading" ? "正在合成语音" : "朗读消息";
  return (
    <button
      type="button"
      className="msg-action"
      title={label}
      aria-label={label}
      aria-pressed={status === "playing"}
      aria-busy={status === "loading"}
      disabled={props.disabled || status === "loading" || !props.text.trim()}
      onClick={() => {
        if (status === "playing") stop();
        else void speak();
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
