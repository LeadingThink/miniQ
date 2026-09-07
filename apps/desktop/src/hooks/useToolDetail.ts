import { useEffect, useState } from "react";
import type { RpcClient } from "../rpc";
import type { ToolCall } from "../types";
import { errorMessage } from "../errorMessage";

export function useToolDetail(client: RpcClient | undefined, call: ToolCall, open: boolean) {
  const key = `${call.id}:${call.status}:${call.completedAt ?? ""}`;
  const [result, setResult] = useState<{ key: string; call?: ToolCall; error?: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const current = result?.key === key ? result : null;
  const needsDetail = Boolean(open && call.payloadDeferred && client && !current?.call);
  useEffect(() => {
    if (!needsDetail || !client) return;
    const request = new AbortController();
    void client.call<ToolCall>("tool.detail", { sessionId: call.sessionId, toolCallId: call.id }, { signal: request.signal })
      .then((detail) => { if (!request.signal.aborted) setResult({ key, call: detail }); })
      .catch((cause) => { if (!request.signal.aborted) setResult({ key, error: errorMessage(cause) }); });
    return () => request.abort();
  }, [client, call.id, call.sessionId, key, needsDetail, attempt]);
  return {
    call: current?.call ?? call,
    loading: needsDetail && !current?.error,
    error: current?.error,
    retry: () => { setResult(null); setAttempt((value) => value + 1); },
  };
}
