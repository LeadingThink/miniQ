import { useEffect, useMemo, useState } from "react";
import type { RpcClient } from "./rpc";
import { isTauriRuntime } from "./runtime";
import { fetchVoiceCapabilities } from "./voiceCapabilities";
import { appleSpeechAvailable } from "./appleSpeech";
import { loadRemoteCredentials } from "./remoteAccess";
import { createMobileVoiceTranscriber, fetchMobileVoiceCapabilities } from "./mobileVoice";

/** Kept separate from speech synthesis: a phone never probes ASR through a host. */
export function useSpeechInput(client?: RpcClient, apiKey?: string) {
  const direct = apiKey !== undefined || (!isTauriRuntime() && client?.mode === "remote");
  const [state, setState] = useState({ transcribe: false, transcribeModel: null as string | null, loading: true, local: false, key: "" });
  useEffect(() => {
    let disposed = false;
    const abort = new AbortController();
    setState({ transcribe: false, transcribeModel: null, loading: true, local: false, key: "" });
    let pending = 2;
    const done = () => { if (!disposed && --pending === 0) setState((s) => ({ ...s, loading: false })); };
    // Local recognition (macOS or iOS SFSpeechRecognizer) must not wait for a slow/unconfigured model service.
    void appleSpeechAvailable().then((local) => {
      if (!disposed && local) setState((s) => ({ ...s, local: true, transcribe: true, loading: false }));
    }).catch(() => {}).finally(done);
    if (direct) {
      void (async () => {
        const key = apiKey ?? client?.remoteConnection?.apiKey ?? (await loadRemoteCredentials())?.apiKey ?? "";
        if (!disposed && key) setState((s) => ({ ...s, key }));
        const capabilities = await fetchMobileVoiceCapabilities(key, abort.signal);
        if (!disposed) setState((s) => ({
          ...s,
          key,
          transcribe: s.local || capabilities.transcribe,
          transcribeModel: capabilities.transcribeModel,
        }));
      })().catch(() => {}).finally(done);
    } else {
      void (client ? fetchVoiceCapabilities(client) : Promise.resolve(null)).then((capabilities) => {
        if (!disposed && capabilities) setState((s) => ({ ...s, transcribe: s.local || capabilities.transcribe,
          transcribeModel: capabilities.transcribeModel }));
      }).catch(() => {}).finally(done);
    }
    return () => { disposed = true; abort.abort(); };
  }, [client, apiKey, direct]);
  const transcriber = useMemo(() => direct && state.transcribeModel
    ? createMobileVoiceTranscriber(state.key, state.transcribeModel) : undefined,
  [direct, state.key, state.transcribeModel]);
  return { capabilities: state, loading: state.loading, preferLocal: state.local, transcriber };
}
