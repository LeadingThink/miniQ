import { CreditCard, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { billingErrorKind } from "../errorMessage";
import { ZAIWEN_BILLING_URL } from "../billingLinks";
import { openExternalUrl } from "../externalLinks";
import { isIosIapAvailable } from "../iosIap";
import "./BillingDialog.css";

const COPY = {
  balance: {
    title: "余额不足",
    body: "在问账户的余额不足，模型请求无法继续。充值后重新发送即可，已输入的内容和会话都会保留。",
  },
  "key-quota": {
    title: "API Key 额度已用完",
    body: "当前 API Key 的额度已用完。可以前往充值，或在在问平台调整该 Key 的额度，也可以更换 API Key。",
  },
} as const;

/** Modal prompt shown when a provider error means the account or key has no credit left.
 * It re-opens for every new billing error and stays closed once dismissed. */
export function BillingDialog(props: {
  error: unknown;
  /** Open the page where the user replaces the API Key. */
  onChangeKey?: () => void;
  /** iOS only: open the in-app purchase page. External payment links are not allowed there. */
  onPurchase?: () => void;
}) {
  const kind = props.error ? billingErrorKind(props.error) : null;
  const [dismissed, setDismissed] = useState<unknown>(null);
  const [openError, setOpenError] = useState(false);
  const primary = useRef<HTMLButtonElement>(null);
  const ios = isIosIapAvailable();
  const visible = kind !== null && dismissed !== props.error;

  useEffect(() => { if (!props.error) setDismissed(null); }, [props.error]);
  useEffect(() => { if (visible) primary.current?.focus(); }, [visible]);
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setDismissed(props.error); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, props.error]);

  if (!visible || !kind) return null;
  const copy = COPY[kind];
  const close = () => { setDismissed(props.error); setOpenError(false); };
  const topUp = () => {
    if (ios) { close(); props.onPurchase?.(); return; }
    setOpenError(false);
    void openExternalUrl(ZAIWEN_BILLING_URL).then(close).catch(() => setOpenError(true));
  };

  return <div className="billing-dialog-backdrop" onClick={close}>
    <div className="billing-dialog" role="alertdialog" aria-modal="true" aria-labelledby="billing-dialog-title"
      aria-describedby="billing-dialog-body" onClick={(event) => event.stopPropagation()}>
      <header>
        <CreditCard size={22} aria-hidden="true" />
        <h2 id="billing-dialog-title">{copy.title}</h2>
        <button type="button" className="billing-dialog-close" aria-label="关闭充值提示" onClick={close}><X size={18} /></button>
      </header>
      <p id="billing-dialog-body">{copy.body}</p>
      {ios && !props.onPurchase && <p>请回到首页，打开「账户、购买额度与 API Key」完成购买。</p>}
      {openError && <p role="alert" className="billing-dialog-error">无法自动打开浏览器，请手动访问 {ZAIWEN_BILLING_URL}</p>}
      <footer>
        {props.onChangeKey && <button type="button" onClick={() => { close(); props.onChangeKey?.(); }}>更换 API Key</button>}
        <button type="button" onClick={close}>稍后处理</button>
        {(!ios || props.onPurchase) && <button type="button" ref={primary} className="primary" onClick={topUp}>{ios ? "购买额度" : "前往充值"}</button>}
      </footer>
    </div>
  </div>;
}
