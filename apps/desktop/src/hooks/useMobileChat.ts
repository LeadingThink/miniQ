import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../errorMessage";
import {
  MOBILE_API_BASE_URL, mobileResponseError, persistMobileChat, readMobileChat,
  type ChatContent, type MobileChatMessage,
} from "../mobileChatData";
import { readSse } from "../mobileChatStream";

export function useMobileChat(apiKey: string, model: string) {
  const [messages, setMessages] = useState<MobileChatMessage[]>(readMobileChat);
  const messagesRef = useRef(messages);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState(false);
  const mounted = useRef(true);
  const active = useRef<{ messageId: string; controller: AbortController; checkpoint: () => void } | null>(null);

  const publish = useCallback((next: MobileChatMessage[], persist: boolean) => {
    messagesRef.current = next;
    if (mounted.current) setMessages(next);
    if (persist) {
      const saved = persistMobileChat(next);
      if (mounted.current) setStorageWarning(!saved);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const checkpoint = () => active.current?.checkpoint();
    const onVisibility = () => { if (document.visibilityState === "hidden") checkpoint(); };
    window.addEventListener("pagehide", checkpoint);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", checkpoint);
      document.removeEventListener("visibilitychange", onVisibility);
      active.current?.controller.abort();
      active.current?.checkpoint();
    };
  }, []);

  const run = (history: MobileChatMessage[]) => {
    if (active.current || !model) return false;
    const controller = new AbortController();
    const messageId = crypto.randomUUID();
    const replyTo = history.at(-1)?.id;
    let output = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const update = (status?: MobileChatMessage["status"], persist = false) => {
      if (timer) clearTimeout(timer);
      timer = null;
      // Unmount already saved a checkpoint. A late abort must not overwrite
      // history that a newly opened chat has since edited.
      if (!mounted.current) return;
      // Update the live record, not the request's original history: users may
      // delete messages while this response is streaming.
      publish(messagesRef.current.map((message) => message.id === messageId
        ? { id: messageId, role: "assistant", content: output, replyTo, ...(status ? { status } : {}) }
        : message), persist);
    };
    active.current = { messageId, controller, checkpoint: () => {
      // A backgrounded page can resume streaming. Save a recoverable checkpoint
      // without presenting the live request as already stopped.
      persistMobileChat(messagesRef.current.map((message) => message.id === messageId
        ? { ...message, content: output, status: "interrupted" } : message));
    } };
    publish([...history, { id: messageId, role: "assistant", content: "", replyTo }], false);
    setBusy(true);
    setError(null);

    void (async () => {
      try {
        const response = await fetch(`${MOBILE_API_BASE_URL}/chat/completions`, {
          method: "POST", signal: controller.signal,
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          // Preserve received partial answers so a follow-up such as “continue”
          // can resume them. Only empty assistant placeholders are omitted.
          body: JSON.stringify({ model, messages: history.filter((message) => message.role === "user"
            || (typeof message.content === "string" ? Boolean(message.content.trim()) : message.content.length > 0))
            .map(({ role, content }) => ({ role, content })), stream: true }),
        });
        if (!response.ok || !response.body) throw new Error(await mobileResponseError(response));
        await readSse(response.body, (delta) => {
          output += delta;
          if (!timer) timer = setTimeout(() => update(), 60);
        }, controller.signal);
        if (!output.trim()) throw new Error("模型返回了空内容，请重试或切换模型");
        update(undefined, true);
      } catch (cause) {
        update(controller.signal.aborted ? "interrupted" : "failed", true);
        if (mounted.current && !controller.signal.aborted) setError(errorMessage(cause));
      } finally {
        if (timer) clearTimeout(timer);
        active.current = null;
        if (mounted.current) setBusy(false);
      }
    })();
    return true;
  };

  const send = (content: ChatContent) => run([...messagesRef.current, { id: crypto.randomUUID(), role: "user", content }]);
  const canRetryMessages = (history: MobileChatMessage[]) => {
    const answer = history.at(-1);
    const question = history.at(-2);
    return Boolean(answer?.status && question?.role === "user" && answer.replyTo === question.id);
  };
  const retry = () => {
    const previous = messagesRef.current;
    if (!canRetryMessages(previous)) return false;
    return run(previous.slice(0, -1));
  };
  const deleteMessage = useCallback((id: string) => {
    if (!messagesRef.current.some((message) => message.id === id)) return;
    if (active.current?.messageId === id) active.current.controller.abort();
    if (messagesRef.current.at(-1)?.id === id) setError(null);
    publish(messagesRef.current.filter((message) => message.id !== id), true);
  }, [publish]);
  return {
    messages, busy, error, storageWarning, send, retry, deleteMessage,
    activeMessageId: active.current?.messageId,
    canRetry: canRetryMessages(messages),
    stop: () => active.current?.controller.abort(),
  };
}
