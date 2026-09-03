import { LoaderCircle, Mic, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { RpcClient } from "../rpc";
import { bytesToBase64, encodeVoiceWav } from "../voiceAudio";

type VoiceState = "idle" | "starting" | "recording" | "transcribing";

interface VoiceResult {
  text: string;
}

interface RecorderResources {
  context: AudioContext;
  processor: ScriptProcessorNode;
  source: MediaStreamAudioSourceNode;
  stream: MediaStream;
  chunks: Float32Array[];
  startedAt: number;
}

const MAX_RECORD_SECONDS = 180;
const MIN_RECORD_SECONDS = 0.5;

export function VoiceInput(props: {
  client: RpcClient;
  onStart: () => void;
  onTranscribed: (text: string) => void;
  onError?: (message: string) => void;
}) {
  const [state, setState] = useState<VoiceState>("idle");
  const [seconds, setSeconds] = useState(0);
  const resourcesRef = useRef<RecorderResources | null>(null);
  const requestVersionRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    requestVersionRef.current += 1;
    releaseRecorder(resourcesRef, timerRef);
  }, []);

  const start = async () => {
    if (state !== "idle") return;
    const version = ++requestVersionRef.current;
    let pendingContext: AudioContext | null = null;
    let pendingStream: MediaStream | null = null;
    props.onStart();
    setState("starting");
    setSeconds(0);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(window.isSecureContext ? "当前系统不支持麦克风录音" : "录音需要安全环境");
      }
      const AudioContextClass = window.AudioContext;
      const context = new AudioContextClass();
      pendingContext = context;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      pendingStream = stream;
      if (version !== requestVersionRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        await context.close();
        return;
      }
      if (context.state === "suspended") await context.resume();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const silentOutput = context.createGain();
      silentOutput.gain.value = 0;
      source.connect(processor);
      processor.connect(silentOutput);
      silentOutput.connect(context.destination);
      const resources: RecorderResources = {
        context,
        processor,
        source,
        stream,
        chunks: [],
        startedAt: performance.now(),
      };
      pendingContext = null;
      pendingStream = null;
      processor.onaudioprocess = (event) => {
        resources.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      resourcesRef.current = resources;
      setState("recording");
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((performance.now() - resources.startedAt) / 1000);
        setSeconds(elapsed);
        if (elapsed >= MAX_RECORD_SECONDS) void stopAndTranscribe();
      }, 250);
    } catch (error) {
      pendingStream?.getTracks().forEach((track) => track.stop());
      if (pendingContext && pendingContext.state !== "closed") void pendingContext.close();
      if (version !== requestVersionRef.current) return;
      releaseRecorder(resourcesRef, timerRef);
      setState("idle");
      props.onError?.(friendlyMicrophoneError(error));
    }
  };

  const stopAndTranscribe = async () => {
    const resources = resourcesRef.current;
    if (!resources) return;
    const version = requestVersionRef.current;
    const duration = (performance.now() - resources.startedAt) / 1000;
    const wav = encodeVoiceWav(resources.chunks, resources.context.sampleRate);
    releaseRecorder(resourcesRef, timerRef);
    if (duration < MIN_RECORD_SECONDS || wav.length <= 44) {
      setState("idle");
      props.onError?.("没有录到足够的声音，请再试一次");
      return;
    }
    setState("transcribing");
    try {
      const result = await props.client.call<VoiceResult>("voice.transcribe", {
        audioBase64: bytesToBase64(wav),
        filename: "record.wav",
      });
      if (version !== requestVersionRef.current) return;
      if (!result.text.trim()) throw new Error("没有识别到文字");
      props.onTranscribed(result.text);
    } catch (error) {
      if (version === requestVersionRef.current) {
        props.onError?.(friendlyTranscriptionError(error));
      }
    } finally {
      if (version === requestVersionRef.current) setState("idle");
    }
  };

  const cancel = () => {
    requestVersionRef.current += 1;
    releaseRecorder(resourcesRef, timerRef);
    setState("idle");
    setSeconds(0);
  };

  const active = state !== "idle";
  const title = voiceLabel(state, seconds);
  return (
    <div className={`voice-input${active ? " active" : ""}`}>
      <button
        type="button"
        className={`attach-btn voice-btn ${state}`}
        title={title}
        aria-label={title}
        aria-pressed={state === "recording"}
        aria-busy={state === "starting" || state === "transcribing"}
        onClick={() => {
          if (state === "idle") void start();
          else if (state === "recording") void stopAndTranscribe();
          else cancel();
        }}
      >
        {state === "idle" && <Mic size={15} />}
        {state === "recording" && <Square size={10} fill="currentColor" />}
        {(state === "starting" || state === "transcribing") && (
          <LoaderCircle className="voice-spinner" size={15} />
        )}
      </button>
      {active && <span className="voice-state" aria-live="polite">{title}</span>}
    </div>
  );
}

function releaseRecorder(
  resourcesRef: MutableRefObject<RecorderResources | null>,
  timerRef: MutableRefObject<ReturnType<typeof setInterval> | null>,
): void {
  if (timerRef.current) clearInterval(timerRef.current);
  timerRef.current = null;
  const resources = resourcesRef.current;
  resourcesRef.current = null;
  if (!resources) return;
  resources.processor.onaudioprocess = null;
  resources.processor.disconnect();
  resources.source.disconnect();
  resources.stream.getTracks().forEach((track) => track.stop());
  void resources.context.close();
}

function voiceLabel(state: VoiceState, seconds: number): string {
  if (state === "starting") return "正在请求麦克风权限";
  if (state === "recording") return `结束录音 ${formatDuration(seconds)}`;
  if (state === "transcribing") return "正在转成文字，点击取消";
  return "语音输入";
}

function formatDuration(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function friendlyMicrophoneError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "麦克风权限被拒绝，请在系统设置中允许 miniQ 使用麦克风";
  if (name === "NotFoundError") return "没有检测到麦克风设备";
  if (name === "NotReadableError") return "麦克风正被其他程序占用";
  return error instanceof Error ? error.message : "无法启动录音";
}

function friendlyTranscriptionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not configured")) return "请先在设置中配置模型服务和 API Key";
  if (message.includes("401") || message.includes("403")) return "语音识别鉴权失败，请检查 API Key";
  return `语音识别失败：${message.replace(/ \(code -?\d+\)$/, "")}`;
}
