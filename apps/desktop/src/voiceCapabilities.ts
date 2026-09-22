import { useEffect, useState } from "react";
import type { RpcClient } from "./rpc";

export interface VoiceCapabilities {
  transcribe: boolean;
  speak: boolean;
  transcribeModel: string | null;
  ttsModel: string | null;
}

export const EMPTY_VOICE_CAPABILITIES: VoiceCapabilities = {
  transcribe: false,
  speak: false,
  transcribeModel: null,
  ttsModel: null,
};

function normalize(value: unknown): VoiceCapabilities {
  if (!value || typeof value !== "object") return EMPTY_VOICE_CAPABILITIES;
  const record = value as Record<string, unknown>;
  const transcribe = record.transcribe === true;
  const speak = record.speak === true;
  const transcribeModel =
    typeof record.transcribeModel === "string" ? record.transcribeModel : null;
  const ttsModel = typeof record.ttsModel === "string" ? record.ttsModel : null;
  return { transcribe, speak, transcribeModel, ttsModel };
}

async function fallbackFromModelList(client: RpcClient): Promise<VoiceCapabilities> {
  try {
    const result = await client.call<{ models: string[] }>("model.list");
    const models = Array.isArray(result.models) ? result.models : [];
    const transcribeModel =
      models.find((id) => id === "grok-transcribe" || id === "sencevoice-small") ?? null;
    const ttsModel = models.find((id) => id === "grok-tts") ?? null;
    return {
      transcribe: transcribeModel !== null,
      speak: ttsModel !== null,
      transcribeModel,
      ttsModel,
    };
  } catch {
    return EMPTY_VOICE_CAPABILITIES;
  }
}

export async function fetchVoiceCapabilities(client: RpcClient): Promise<VoiceCapabilities> {
  try {
    const result = await client.call<unknown>("voice.capabilities");
    // Old daemons without the new RPC still expose model.list; fall back to it
    // so gated buttons keep working across upgrades.
    if (result === null || result === undefined) return fallbackFromModelList(client);
    return normalize(result);
  } catch (cause) {
    const message = String(cause);
    if (message.includes("unknown method") || message.includes("MethodNotFound")) {
      return fallbackFromModelList(client);
    }
    return EMPTY_VOICE_CAPABILITIES;
  }
}

export function useVoiceCapabilities(client?: RpcClient): {
  capabilities: VoiceCapabilities;
  loading: boolean;
} {
  const [capabilities, setCapabilities] = useState<VoiceCapabilities>(
    EMPTY_VOICE_CAPABILITIES,
  );
  const [loading, setLoading] = useState(Boolean(client));
  useEffect(() => {
    if (!client) {
      setCapabilities(EMPTY_VOICE_CAPABILITIES);
      setLoading(false);
      return;
    }
    let stale = false;
    setLoading(true);
    void fetchVoiceCapabilities(client)
      .then((value) => {
        if (!stale) setCapabilities(value);
      })
      .catch(() => {
        if (!stale) setCapabilities(EMPTY_VOICE_CAPABILITIES);
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [client]);
  return { capabilities, loading };
}
