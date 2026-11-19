import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcClient } from "../rpc";
import type { OneApiKey } from "../mobileIapAccount";
import { isUsableDesktopAccountKey } from "../desktopAccountKey";
import { hasZaiwenKey, loadZaiwenImportKeys, selectZaiwenKey, zaiwenSessionStatus, type ImportProvider } from "../zaiwenKeyImport";

interface ImportPrompt {
  sessionId: string;
  keys: OneApiKey[] | null;
  selectedKeyId: string | null;
}

/** Listing and selection share the same cancellation and error lifecycle. */
function useImportOperation() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const operation = useRef<AbortController | null>(null);
  const cancel = useCallback(() => {
    operation.current?.abort(); operation.current = null; setBusy(false);
  }, []);
  const run = useCallback(async (action: (signal: AbortSignal) => Promise<void>) => {
    if (operation.current) return;
    const cancellation = new AbortController();
    operation.current = cancellation; setBusy(true); setMessage("");
    try { await action(cancellation.signal); }
    catch (cause) {
      if (!cancellation.signal.aborted) setMessage(cause instanceof Error ? cause.message : "操作失败，请重试。");
    } finally {
      if (operation.current === cancellation) { operation.current = null; setBusy(false); }
    }
  }, []);
  useEffect(() => () => { operation.current?.abort(); operation.current = null; }, []);
  return { busy, message, setMessage, operation, cancel, run };
}

export function useZaiwenKeyImport(active: boolean, client?: RpcClient) {
  const [prompt, setPrompt] = useState<ImportPrompt | null>(null);
  const [configured, setConfigured] = useState(false);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const selectedSession = useRef<string | null>(null);
  const { busy, message, setMessage, operation, cancel, run } = useImportOperation();
  const seen = useRef(new Set<string>());
  const session = useRef<string | null>(null);
  const current = useRef({ active, client });
  current.current = { active, client };

  const inspect = useCallback(async (explicit: boolean, valid: () => boolean) => {
    if (!client || client.mode !== "local" || client.sshHost) {
      if (valid()) setMessage("选择在问 API Key 仅支持桌面本机。");
      return false;
    }
    const status = await zaiwenSessionStatus();
    if (!valid()) return false;
    if (session.current !== status.sessionId) {
      cancel(); setPrompt(null); setMessage("");
      session.current = status.sessionId;
      if (selectedSession.current !== status.sessionId) {
        selectedSession.current = null;
        setSelectedKeyId(null);
      }
      seen.current.clear();
    }
    if (!status.supported) {
      setMessage("此平台尚不支持读取主站登录态，可在模型设置中登录账户或手动填写 API Key。");
      return false;
    }
    const { provider } = await client.call<{ provider: ImportProvider | null }>("settings.get");
    if (!valid() || session.current !== status.sessionId) return false;
    const hasSavedKey = hasZaiwenKey(provider);
    setConfigured(hasSavedKey);
    if (!status.sessionId) {
      if (explicit) setMessage("请先在在问主站登录，登录后可选择 API Key。");
      return true;
    }
    const sessionId = status.sessionId;
    if (!explicit && selectedSession.current === sessionId) return true;
    if (!explicit && seen.current.has(sessionId)) return true;
    seen.current.add(sessionId);
    if (!explicit && hasSavedKey) return true;
    if (operation.current) return true;
    setPrompt({ sessionId, keys: null, selectedKeyId: null });
    void run(async (signal) => {
      const keys = await loadZaiwenImportKeys(client, sessionId, signal);
      if (!signal.aborted && valid()) setPrompt({ sessionId, keys, selectedKeyId: null });
    });
    return true;
  }, [client, cancel, operation, run, setMessage]);

  useEffect(() => {
    seen.current.clear();
    setConfigured(false);
    setMessage("");
    if (!active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let again = true;
      try { again = await inspect(false, () => !disposed); }
      catch { if (!disposed) setMessage("暂时无法读取在问登录状态，可点击选择在问 API Key 重试。"); }
      if (!disposed && again) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [active, inspect, setMessage]);

  const dismiss = useCallback(() => {
    cancel(); setPrompt(null);
  }, [cancel]);
  useEffect(() => {
    if (!active) dismiss();
    return cancel;
  }, [active, client, cancel, dismiss]);

  const request = async () => {
    if (operation.current || busy || !current.current.active) return;
    try { await inspect(true, () => current.current.active && current.current.client === client); }
    catch { setMessage("读取在问登录状态失败，请重试。"); }
  };
  const confirm = async () => {
    if (!prompt || !client || operation.current || busy || !current.current.active) return;
    if (prompt.selectedKeyId !== null && prompt.selectedKeyId === selectedKeyId) return;
    if (!prompt.keys || (prompt.keys.some(isUsableDesktopAccountKey) && !prompt.selectedKeyId)) return;
    await run(async (signal) => {
      const selected = await selectZaiwenKey(client, prompt.sessionId, signal, prompt.selectedKeyId);
      if (signal.aborted) return;
      setSelectedKeyId(selected.key_id); selectedSession.current = prompt.sessionId;
      setPrompt(null); setMessage("");
    });
  };
  const selectKey = (nextKeyId: string) => {
    if (!busy && nextKeyId !== selectedKeyId) setPrompt((value) => value?.keys?.some((key) => key.key_id === nextKeyId && isUsableDesktopAccountKey(key))
      ? { ...value, selectedKeyId: nextKeyId } : value);
  };
  return { prompt, configured, selectedKeyId, busy, message, request, confirm, dismiss, selectKey };
}
