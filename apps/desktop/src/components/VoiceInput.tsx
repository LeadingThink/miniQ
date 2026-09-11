import { LoaderCircle, Mic, RotateCcw, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RpcClient } from "../rpc";
import { startVoiceCapture, type VoiceCapture } from "../voiceCapture";
import { VoiceTranscription, type VoicePreview } from "../voiceTranscription";

interface Props {
  client: RpcClient;
  onStart: () => void;
  onTranscribed: (text: string) => void;
  onPreview: (preview: VoicePreview | null) => void;
  onError?: (message: string) => void;
  disabled?: boolean;
}
interface Recording {
  abort: AbortController;
  capture?: VoiceCapture;
  transcript?: VoiceTranscription;
  timer?: ReturnType<typeof setInterval>;
  finishing: boolean;
  startedAt: number;
}

export function VoiceInput(props: Props) {
  const [state, setState] = useState<"idle" | VoicePreview["phase"]>("idle");
  const [seconds, setSeconds] = useState(0);
  const current = useRef<Recording | null>(null);
  const callbacks = useRef(props); callbacks.current = props;
  const cancel = () => {
    const recording = current.current; current.current = null;
    if (recording) release(recording);
    setState("idle"); setSeconds(0); callbacks.current.onPreview(null);
  };
  useEffect(() => () => {
    const recording = current.current; current.current = null;
    if (recording) release(recording);
  }, []);

  const finish = async (recording: Recording) => {
    if (current.current !== recording || recording.finishing) return;
    recording.finishing = true;
    clearInterval(recording.timer); recording.capture?.stop();
    const transcript = recording.transcript;
    if (!transcript || transcript.duration < 0.5) {
      cancel(); callbacks.current.onError?.("没有录到足够的声音，请再试一次"); return;
    }
    setState("transcribing");
    callbacks.current.onPreview({ phase: "transcribing", text: transcript.text });
    try {
      const text = await transcript.finish();
      if (current.current !== recording) return;
      if (!text) throw new Error("没有识别到文字，请重新录音");
      callbacks.current.onTranscribed(text); cancel();
    } catch (error) {
      if (current.current !== recording) return;
      recording.finishing = false; setState("failed");
      callbacks.current.onPreview({ phase: "failed", text: transcript.text, error: friendlyError(error) });
    }
  };

  const start = async () => {
    if (current.current || props.disabled) return;
    const recording: Recording = { abort: new AbortController(), finishing: false, startedAt: performance.now() };
    current.current = recording;
    callbacks.current.onStart(); setState("starting"); setSeconds(0);
    callbacks.current.onPreview({ phase: "starting", text: "" });
    try {
      recording.capture = await startVoiceCapture(recording.abort.signal, (samples, sampleRate) => {
        if (current.current !== recording) return;
        recording.transcript ??= new VoiceTranscription(props.client, sampleRate, (text, delayed) => {
          if (current.current === recording) callbacks.current.onPreview({
            phase: recording.finishing ? "transcribing" : "recording", text, delayed,
          });
        });
        recording.transcript.append(samples);
      }, () => void finish(recording));
      if (current.current !== recording) { recording.capture.stop(); return; }
      recording.startedAt = performance.now(); setState("recording");
      callbacks.current.onPreview({ phase: "recording", text: "" });
      let previewAt = 0;
      recording.timer = setInterval(() => {
        const elapsed = (performance.now() - recording.startedAt) / 1000;
        setSeconds(Math.floor(elapsed));
        if (elapsed >= 180) { void finish(recording); return; }
        if (elapsed - previewAt >= 2) { previewAt = elapsed; void recording.transcript?.preview(); }
      }, 250);
    } catch (error) {
      if (current.current !== recording) return;
      cancel(); callbacks.current.onError?.(friendlyError(error));
    }
  };

  const active = state !== "idle";
  const label = state === "recording" ? "结束录音" : state === "failed" ? "重试语音识别" : state === "idle" ? "语音输入" : state === "starting" ? "正在请求麦克风权限" : "正在校正转录";
  return <div className={`voice-input${active ? " active" : ""}`}>
    <button type="button" className={`attach-btn voice-btn ${state}`} title={label} aria-label={label}
      aria-pressed={state === "recording"} aria-busy={state === "starting" || state === "transcribing"}
      disabled={props.disabled || state === "starting" || state === "transcribing"}
      onClick={() => { if (current.current) void finish(current.current); else void start(); }}>
      {state === "idle" ? <Mic size={15} /> : state === "recording" ? <Square size={10} fill="currentColor" />
        : state === "failed" ? <RotateCcw size={15} /> : <LoaderCircle className="voice-spinner" size={15} />}
    </button>
    {active && <><span className="voice-state">{state === "recording" ? `正在听 ${duration(seconds)}` : label}</span>
      <button type="button" className="attach-btn" aria-label="取消语音输入" title="取消语音输入" onClick={cancel}><X size={14} /></button></>}
  </div>;
}

function release(recording: Recording) {
  clearInterval(recording.timer); recording.abort.abort();
  recording.capture?.stop(); recording.transcript?.cancel();
}
function duration(seconds: number) { return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
function friendlyError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "麦克风权限被拒绝，请在系统设置中允许 miniQ 使用麦克风";
  if (name === "NotFoundError") return "没有检测到麦克风设备";
  if (name === "NotReadableError") return "麦克风正被其他程序占用";
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("not configured")) return "请先在设置中配置模型服务和 API Key";
  if (message.includes("401") || message.includes("403")) return "语音识别鉴权失败，请检查 API Key";
  return message.replace(/ \(code -?\d+\)$/, "");
}
