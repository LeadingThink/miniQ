import { useCallback, useEffect, useRef, useState } from "react";
import { IapApiError, deleteIapAccount, loadOneApiAccount, logoutIapAccount, type OneApiAccount } from "../mobileIapAccount";
import { MobileAccountLogin } from "./MobileAccountLogin";
import { MobileAccountKeys } from "./MobileAccountKeys";
import { MobilePurchasePanel } from "./MobilePurchasePanel";
import { hasMobilePrivacyConsent } from "../mobilePrivacy";
import "./MobileAccountPanel.css";

export function MobileAccountPanel(props: { onBack: () => void; onBusyChange: (busy: boolean) => void }) {
  const [account, setAccount] = useState<OneApiAccount | null>(null);
  const [pending, setPending] = useState(false);
  const [purchaseBusy, setPurchaseBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = useRef(false);
  const busy = pending || purchaseBusy;
  const run = useCallback((action: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setPending(true); setError(null);
    void action().catch((cause) => {
      if (cause instanceof IapApiError && cause.code === "-2") setAccount(null);
      setError(cause instanceof Error ? cause.message : "操作未完成，请稍后重试。");
    }).finally(() => { working.current = false; setPending(false); });
  }, []);
  useEffect(() => {
    if (hasMobilePrivacyConsent()) run(async () => setAccount(await loadOneApiAccount()));
  }, [run]);
  useEffect(() => { props.onBusyChange(busy); }, [busy, props.onBusyChange]);
  useEffect(() => () => props.onBusyChange(false), [props.onBusyChange]);
  return <main className="mobile-entry">
    <div className="mobile-account-panel" aria-busy={busy}>
      <h1>账户与 API Key</h1>
      <button type="button" className="secondary" disabled={busy} onClick={props.onBack}>返回填写 API Key</button>
      {error && <p role="alert" className="mobile-entry-error">{error}</p>}
      {pending && <p role="status">正在处理…</p>}
      {!account ? <MobileAccountLogin busy={busy} run={run} onLogin={setAccount} /> : <>
        <p>当前账户：{account.phone}<br />账户余额：¥{account.balance.toFixed(4)}</p>
        <p>购买额度充值到此手机号账户。填写其他账户的 Key 时，不会使用这里的余额。连接桌面时，手机和电脑需填写同一个 Key。</p>
        <div className="mobile-account-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => run(async () => setAccount(await loadOneApiAccount()))}>刷新余额</button>
          <button type="button" className="secondary" disabled={busy} onClick={() => run(async () => { await logoutIapAccount(); setAccount(null); setConfirmDelete(false); })}>退出账户登录</button>
        </div>
        <MobilePurchasePanel disabled={pending} onBusyChange={setPurchaseBusy}
          onSettled={async () => { setAccount(await loadOneApiAccount()); }} />
        <MobileAccountKeys busy={busy} run={run} />
        <details><summary>注销在问账户</summary>
          <p>注销的是与网页共用的在问账户，不只是退出 miniQ；账户及其 Key 将无法继续使用。请先确认余额、未完成购买及退款已处理。</p>
          <label><input type="checkbox" checked={confirmDelete} disabled={busy} onChange={(event) => setConfirmDelete(event.target.checked)} />我确认注销这个在问账户</label>
          <button type="button" className="secondary" disabled={busy || !confirmDelete} onClick={() => run(async () => { await deleteIapAccount(); setAccount(null); setConfirmDelete(false); })}>确认注销账户</button>
        </details>
      </>}
    </div>
  </main>;
}
