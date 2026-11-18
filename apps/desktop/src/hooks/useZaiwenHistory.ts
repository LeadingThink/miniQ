import { useCallback, useEffect, useRef, useState } from "react";
import { ZaiwenApiError } from "../zaiwenApi";
import type { ZaiwenSession } from "../zaiwenAuth";
import { listZaiwenConversations, listZaiwenMessages, mergeZaiwenPage, zaiwenTimestamp, type ZaiwenConversation, type ZaiwenPage } from "../zaiwenHistory";

interface PageState<T> extends ZaiwenPage<T> {
  key: string;
  loading: boolean;
  error: string;
  requiresLogin: boolean;
}

function emptyPage<T>(key: string): PageState<T> {
  return { key, items: [], total: 0, cursor: null, loading: false, error: "", requiresLogin: false };
}

/** Cancel replaced requests and hide an old account's data before effects run. */
function useHistoryPage<T extends { id: string }>(key: string, active: boolean, fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<ZaiwenPage<T>>) {
  const [stored, setStored] = useState<PageState<T>>(() => emptyPage(key));
  const state = stored.key === key ? stored : emptyPage<T>(key);
  const latest = useRef(state);
  latest.current = state;
  const request = useRef<AbortController | null>(null);
  const run = useCallback(async (more: boolean) => {
    if (!active || !key || (more && (latest.current.loading || !latest.current.cursor))) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const previous = latest.current;
    setStored({ ...previous, key, loading: true, error: "", requiresLogin: false });
    try {
      const page = await fetchPage(more ? previous.cursor : null, controller.signal);
      if (controller.signal.aborted) return;
      setStored({ ...page, key, items: more ? mergeZaiwenPage(previous.items, page.items) : page.items,
        loading: false, error: "", requiresLogin: false });
    } catch (cause) {
      if (controller.signal.aborted) return;
      const requiresLogin = cause instanceof ZaiwenApiError && cause.requiresLogin;
      setStored({ ...(requiresLogin ? emptyPage<T>(key) : previous), key, loading: false, requiresLogin,
        error: requiresLogin ? "在问登录已失效，请重新登录" : cause instanceof Error ? cause.message : "聊天记录加载失败，请重试" });
      return { error: cause };
    }
  }, [key, active, fetchPage]);
  const refresh = useCallback(() => { void run(false); }, [run]);
  const loadMore = useCallback(() => run(true), [run]);
  useEffect(() => {
    refresh();
    return () => request.current?.abort();
  }, [refresh]);
  return { ...state, refresh, loadMore };
}

export function useZaiwenHistory(session: ZaiwenSession | null, active: boolean) {
  const owner = session ? JSON.stringify([session.user.uid, session.token]) : "";
  const [selection, setSelection] = useState<{ owner: string; conversation: ZaiwenConversation } | null>(null);
  const chosen = selection?.owner === owner ? selection.conversation : null;
  const fetchConversations = useCallback((cursor: string | null, signal: AbortSignal) =>
    listZaiwenConversations(session!, cursor, signal), [session]);
  const conversations = useHistoryPage(owner, active && !!session, fetchConversations);
  const selected = conversations.items.find((item) => item.id === chosen?.id) ?? chosen;
  const fetchMessages = useCallback((cursor: string | null, signal: AbortSignal) =>
    listZaiwenMessages(session!, selected!.id, cursor, signal), [session, selected?.id]);
  const messages = useHistoryPage(selected ? JSON.stringify([owner, selected.id]) : "", active && !!session && !!selected, fetchMessages);
  const refresh = useCallback(() => {
    conversations.refresh();
    messages.refresh();
  }, [conversations.refresh, messages.refresh]);
  useEffect(() => {
    if (!active || !owner) return;
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [active, owner, refresh]);
  return {
    conversations, messages: { ...messages, items: [...messages.items].sort((a, b) =>
      zaiwenTimestamp(a.created) - zaiwenTimestamp(b.created) || a.id.localeCompare(b.id)) },
    selected, select: (conversation: ZaiwenConversation | null) => setSelection(conversation ? { owner, conversation } : null),
    refresh, requiresLogin: conversations.requiresLogin || messages.requiresLogin,
  };
}

export type ZaiwenHistory = ReturnType<typeof useZaiwenHistory>;
