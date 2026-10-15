import { useEffect, useRef, useState } from "react";
import { IapApiError, createOneApiKey, loadOneApiAccount, loadOneApiKeys, logoutIapAccount, type OneApiAccount } from "../mobileIapAccount";
import { MobileAccountLogin } from "./MobileAccountLogin";
import "./DesktopAccountLogin.css";

/** Reuse an active key before creating one; never replace a key merely because it is on a later page. */
export async function acquireDesktopAccountKey(): Promise<string> {
  let page = 1;
  let count = 0;
  while (true) {
    const result = await loadOneApiKeys(page);
    const usable = result.keys.find((key) => key.is_active && key.expire_time > Date.now() / 1000);
    if (usable) return usable.sk;
    count += result.keys.length;
    if (count >= result.total) break;
    if (result.keys.length === 0) throw new Error("Key 列表加载不完整，请重试。");
    page += 1;
  }
  return (await createOneApiKey("miniQ 桌面端")).sk;
}

export function DesktopAccountLogin(props: { disabled: boolean; onKey: (key: string) => void; onBusyChange: (busy: boolean) => void }) {
  const [account, setAccount] = useState<OneApiAccount | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const working = useRef(false);
  const mounted = useRef(true);
  const busy = pending || props.disabled;
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void loadOneApiAccount().then((value) => { if (!cancelled) setAccount(value); })
      .catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "账户读取失败，请重试。"); })
      .finally(() => { if (!cancelled) setPending(false); });
    return () => { cancelled = true; mounted.current = false; };
  }, []);
  useEffect(() => { props.onBusyChange(pending); }, [pending, props.onBusyChange]);
  useEffect(() => () => props.onBusyChange(false), [props.onBusyChange]);
  const run = (action: () => Promise<void>) => {
    if (working.current || busy) return;
    working.current = true;
    setPending(true); setError(null); setMessage(null);
    void action().catch((cause) => {
      if (!mounted.current) return;
      if (cause instanceof IapApiError && cause.code === "-2") setAccount(null);
      setError(cause instanceof Error ? cause.message : "账户操作失败，请重试。");
    }).finally(() => { working.current = false; if (mounted.current) setPending(false); });
  };
  const fillKey = async () => {
    const key = await acquireDesktopAccountKey();
    if (!mounted.current) return;
    props.onKey(key);
    setMessage("已填入账户 API Key，点击保存即可使用。");
  };
  return <section className="desktop-account-login" aria-label="在问账户登录" aria-busy={pending}>
    <p>登录后自动获取可用 API Key；没有可用 Key 时会创建一个。也可以直接填写下方的 API Key。</p>
    {pending && <p role="status">正在处理账户请求…</p>}
    {error && <p role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
    {!account ? <MobileAccountLogin embedded busy={busy} run={run} submitLabel="登录并获取 API Key"
      onLogin={async (value) => { if (mounted.current) setAccount(value); await fillKey(); }} /> : <>
      <p>当前账户：{account.phone} · 余额 ¥{account.balance.toFixed(4)}</p>
      <div className="desktop-account-actions">
        <button type="button" disabled={busy} onClick={() => run(fillKey)}>获取账户 API Key</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => run(async () => {
          await logoutIapAccount();
          if (mounted.current) { setAccount(null); setMessage("已退出账户登录。已保存的 API Key 仍可使用。"); }
        })}>退出账户登录</button>
      </div>
    </>}
  </section>;
}
