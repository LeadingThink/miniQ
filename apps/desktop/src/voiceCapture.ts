export interface VoiceCapture { stop: () => void }

export async function startVoiceCapture(signal: AbortSignal,
  onSamples: (samples: Float32Array, sampleRate: number) => void,
  onEnded: () => void): Promise<VoiceCapture> {
  if (!navigator.mediaDevices?.getUserMedia)
    throw new Error(window.isSecureContext ? "当前系统不支持麦克风录音" : "录音需要安全环境");
  const context = new AudioContext();
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let processor: ScriptProcessorNode | undefined;
  let output: GainNode | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true; signal.removeEventListener("abort", stop);
    if (processor) { processor.onaudioprocess = null; processor.disconnect(); processor = undefined; }
    source?.disconnect(); source = undefined; output?.disconnect(); output = undefined;
    stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    stream = undefined;
    if (context.state !== "closed") void context.close().catch(() => {});
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    // Resume during the button's user gesture, before awaiting permission.
    // Safari/WebView may otherwise keep the audio context suspended.
    const ready = context.state === "suspended" ? context.resume() : Promise.resolve();
    void ready.catch(() => {});
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    signal.throwIfAborted();
    await ready;
    signal.throwIfAborted();
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(4096, 1, 1);
    output = context.createGain(); output.gain.value = 0;
    processor.onaudioprocess = (event) => {
      if (!stopped) onSamples(new Float32Array(event.inputBuffer.getChannelData(0)), context.sampleRate);
    };
    for (const track of stream.getAudioTracks()) track.onended = () => { if (!stopped) onEnded(); };
    source.connect(processor); processor.connect(output); output.connect(context.destination);
    return { stop };
  } catch (error) { stop(); throw error; }
}
