import { useLayoutEffect, useRef } from "react";
import type { VoicePreview } from "../voiceTranscription";

export function VoiceTranscript({ preview }: { preview: VoicePreview }) {
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    if (follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [preview.text]);
  const label = preview.phase === "transcribing" ? "正在校正，完成后填入输入框"
    : preview.phase === "failed" ? "识别未完成，可重试或取消" : "实时转录";
  const placeholder = preview.phase === "starting" ? "正在连接麦克风…"
    : preview.phase === "transcribing" ? "正在识别完整录音…"
    : preview.phase === "failed" ? "录音已保留，可点击重试重新识别。" : "请开始说话，文字会逐步显示…";
  return <section className="voice-transcript" aria-label="语音转录预览">
    <header><span className={preview.phase === "recording" ? "voice-live-dot" : ""} />{label}</header>
    <div ref={scroller} className="voice-transcript-text" role="status" aria-live="polite" aria-atomic="true"
      onScroll={() => { const el = scroller.current!; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
      {preview.text || placeholder}
    </div>
    {preview.delayed && <small>识别稍慢，录音仍完整保留。</small>}
    {preview.error && <p role="alert">{preview.error}</p>}
  </section>;
}
