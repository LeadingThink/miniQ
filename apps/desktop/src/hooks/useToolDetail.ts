import type { RpcClient } from "../rpc";
import type { ToolCall } from "../types";
import { useDeferredDetail } from "./useDeferredDetail";

export function useToolDetail(client: RpcClient | undefined, call: ToolCall, open: boolean) {
  const detail = useDeferredDetail<ToolCall>(client, "tool.detail", {
    sessionId: call.sessionId, toolCallId: call.id,
  }, [call.status, call.completedAt], open && !!call.payloadDeferred);
  return { ...detail, call: call.payloadDeferred ? detail.value ?? call : call };
}
