import type { Message, Session } from "./types";
import type { ZaiwenSession } from "./zaiwenAuth";
import { listZaiwenMessages, mergeZaiwenPage, zaiwenTimestamp, type ZaiwenConversation, type ZaiwenMessage } from "./zaiwenHistory";

/** View data only: cloud records are never inserted into the daemon catalog. */
export function zaiwenSessionView(conversation: ZaiwenConversation): Session {
  return {
    id: conversation.id,
    workspaceId: "",
    workingDirectory: "",
    title: conversation.title || "未命名会话",
    status: "idle",
    pinned: !!conversation.pinned,
    archived: false,
    createdAt: new Date(zaiwenTimestamp(conversation.created)).toISOString(),
    updatedAt: new Date(zaiwenTimestamp(conversation.updated ?? conversation.created)).toISOString(),
  };
}

export function zaiwenMessageView(message: ZaiwenMessage, sessionId: string): Message & { zaiwen: ZaiwenMessage } {
  const role = message.role === "user" || message.role === "system" || message.role === "tool" ? message.role : "assistant";
  return { id: message.id, sessionId, role, content: message.content, zaiwen: message,
    createdAt: new Date(zaiwenTimestamp(message.created)).toISOString() };
}

export async function readZaiwenTranscript(session: ZaiwenSession, conversationId: string, sessionId: string, signal: AbortSignal) {
  let cursor: string | null = null;
  let messages: ZaiwenMessage[] = [];
  const visited = new Set<string>();
  do {
    signal.throwIfAborted();
    const page = await listZaiwenMessages(session, conversationId, cursor, signal);
    messages = mergeZaiwenPage(messages, page.items);
    cursor = page.cursor;
    if (cursor) {
      if (visited.has(cursor)) throw new Error("在问聊天记录分页重复，请刷新重试");
      visited.add(cursor);
    }
  } while (cursor);
  signal.throwIfAborted();
  return { messages: messages.sort((a, b) => zaiwenTimestamp(a.created) - zaiwenTimestamp(b.created) || a.id.localeCompare(b.id))
    .map((message) => zaiwenMessageView(message, sessionId)), toolCalls: [] };
}
