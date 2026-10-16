import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { ZAIWEN_BILLING_URL } from "../billingLinks";
import { openExternalUrl } from "../externalLinks";

/** Android top-up: payment happens on the Zaiwen web page, not inside the app. */
export function MobileWebTopUp(props: { disabled: boolean; onReturned: () => void }) {
  const [failed, setFailed] = useState(false);
  return <section className="mobile-purchase-panel" aria-label="充值 AI 使用额度">
    <div className="mobile-purchase-heading"><div><strong>充值 AI 使用额度</strong>
      <p>充值在在问网页完成，用同一个手机号登录即可。充值后回到这里刷新余额。</p></div></div>
    <div className="mobile-account-actions">
      <button type="button" disabled={props.disabled} onClick={() => {
        setFailed(false);
        void openExternalUrl(ZAIWEN_BILLING_URL).catch(() => setFailed(true));
      }}>前往在问充值<ExternalLink size={13} /></button>
      <button type="button" className="secondary" disabled={props.disabled} onClick={props.onReturned}>已充值，刷新余额</button>
    </div>
    {failed && <p className="mobile-entry-error" role="alert">无法自动打开浏览器，请手动访问 {ZAIWEN_BILLING_URL}</p>}
  </section>;
}
