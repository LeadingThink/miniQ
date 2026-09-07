import type { RpcClient } from "./rpc";
import type { HistoryPage, Message, ToolCall } from "./types";

export async function readExportHistory(client: RpcClient, sessionId: string, signal: AbortSignal) {
  const messages: Message[] = [];
  const toolCalls: ToolCall[] = [];
  let before: HistoryPage["nextCursor"] = null;
  do {
    const page: HistoryPage = await client.call("session.history", {
      sessionId, before, limit: 100, includePayloads: true, includeInternal: true,
    }, { signal });
    messages.unshift(...page.messages);
    toolCalls.unshift(...page.toolCalls);
    before = page.nextCursor;
  } while (before && !signal.aborted);
  if (signal.aborted) throw new DOMException("Export cancelled", "AbortError");
  return { messages, toolCalls };
}
