import { useEffect, useRef, useState } from "react";
import type { ZaiwenSession } from "../zaiwenAuth";
import { ZaiwenApiError } from "../zaiwenApi";
import { cancelZaiwenMessage, listZaiwenChatModels, streamZaiwenMessage, zaiwenEventMessage, type ZaiwenChatModel } from "../zaiwenChat";
import type { ZaiwenHistory } from "./useZaiwenHistory";
import { mergeZaiwenPage, type ZaiwenMessage } from "../zaiwenHistory";

/** A mounted conversation owns its stream; cloud content never enters the local daemon. */
export function useZaiwenChat(session: ZaiwenSession, history: ZaiwenHistory) {
  const conversationId = history.selected!.id;
  const latest = useRef(history);
  latest.current = history;
  const mounted = useRef(false);
  const active = useRef<{ controller: AbortController; requestId: string; settle: (accepted: boolean) => void } | null>(null);
  const [models, setModels] = useState<ZaiwenChatModel[]>([]);
  const [model, setModel] = useState("");
  const [modelError, setModelError] = useState("");
  const [modelsRevision, setModelsRevision] = useState(0);
  const [updates, setUpdates] = useState<ZaiwenMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState("");
  const [requiresLogin, setRequiresLogin] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.settle(false); active.current?.controller.abort(); };
  }, []);
  useEffect(() => {
    if (busy) return;
    const saved = new Set(history.messages.items.map((item) => item.id));
    setUpdates((previous) => {
      const pending = previous.filter((item) => !saved.has(item.id));
      return pending.length === previous.length ? previous : pending;
    });
  }, [history.messages.items, busy]);
  useEffect(() => {
    const request = new AbortController();
    setModelError("");
    void listZaiwenChatModels(session, request.signal).then((items) => {
      if (request.signal.aborted) return;
      setRequiresLogin(false);
      setModels(items);
      setModel((current) => {
        const previous = [...latest.current.messages.items].reverse().find((item) => item.role === "assistant" && item.model)?.model;
        return items.find((item) => item.key === (current || previous))?.key ?? items[0].key;
      });
    }).catch((cause) => {
      if (request.signal.aborted) return;
      setModelError(cause instanceof Error ? cause.message : "模型加载失败");
      if (cause instanceof ZaiwenApiError && cause.requiresLogin) setRequiresLogin(true);
    });
    return () => request.abort();
  }, [session, modelsRevision]);

  const send = (content: string): Promise<boolean> => {
    if (active.current || !model || !content.trim() || requiresLogin || latest.current.messages.loading || latest.current.messages.error) return Promise.resolve(false);
    const controller = new AbortController();
    let settle!: (accepted: boolean) => void;
    const accepted = new Promise<boolean>((resolve) => { settle = resolve; });
    const request = { controller, requestId: "", settle };
    active.current = request;
    const created = Date.now();
    const userId: string = crypto.randomUUID(), assistantId: string = crypto.randomUUID();
    let user: ZaiwenMessage = { id: userId, role: "user", content, created };
    let assistant: ZaiwenMessage = { id: assistantId, role: "assistant", content: "", created: created + 1, model };
    let confirmed = false;
    const current = () => mounted.current && active.current === request;
    const publish = () => {
      if (current()) setUpdates((previous) => [...previous.filter((item) => ![userId, assistantId, user.id, assistant.id].includes(item.id)), user, assistant]);
    };
    setBusy(true); setError(""); publish();
    void streamZaiwenMessage(session, conversationId, content, model, controller.signal, (event) => {
      if (!current()) return;
      if (event.type === "user-message") user = zaiwenEventMessage(event.data);
      if (event.type === "assistant-message") assistant = zaiwenEventMessage(event.data);
      if (event.type === "streaming" && typeof event.content === "string") assistant = { ...assistant, content: assistant.content + event.content };
      if (["user-message", "assistant-message", "streaming"].includes(event.type)) { confirmed = true; settle(true); }
      publish();
    }, (id) => { if (current()) request.requestId = id; }).then(() => {
      if (!confirmed) throw new Error("在问未确认接收消息，请刷新会话后重试");
      if (current()) latest.current.conversations.refresh();
    }).catch((cause) => {
      if (!current() || controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "发送失败，请重试");
      if (cause instanceof ZaiwenApiError && cause.requiresLogin) setRequiresLogin(true);
      if (!confirmed) setUpdates((previous) => previous.filter((item) => ![userId, assistantId].includes(item.id)));
    }).finally(() => {
      settle(confirmed);
      if (current()) { active.current = null; setBusy(false); setStopping(false); }
    });
    return accepted;
  };
  const stop = async () => {
    const request = active.current;
    if (!request || stopping) return;
    if (!request.requestId) { setError("请求正在连接，请稍候再停止"); return; }
    setStopping(true);
    try {
      await cancelZaiwenMessage(session, conversationId, request.requestId);
      // Keep receiving the final persisted message after the server acknowledges cancellation.
    } catch (cause) {
      if (!mounted.current || active.current !== request) return;
      setStopping(false);
      setError(cause instanceof Error ? cause.message : "停止失败，请重试");
      if (cause instanceof ZaiwenApiError && cause.requiresLogin) setRequiresLogin(true);
    }
  };
  return { models, model, setModel, modelError, retryModels: () => setModelsRevision((value) => value + 1),
    messages: mergeZaiwenPage(history.messages.items, updates), busy, stopping, error, setError, requiresLogin, send, stop };
}
