import { useEffect, useState } from "react";
import { MINIQ_PRIVACY_URL, hasMobilePrivacyConsent, recordMobilePrivacyConsent } from "../mobilePrivacy";
import { loginIapAccount, requestIapLoginCode, type OneApiAccount } from "../mobileIapAccount";

export type AccountAction = (action: () => Promise<void>) => void;

export function MobileAccountLogin(props: { busy: boolean; run: AccountAction; onLogin: (account: OneApiAccount) => void }) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [consent, setConsent] = useState(hasMobilePrivacyConsent);
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  const accept = () => {
    if (!consent) throw new Error("请先阅读并同意隐私政策。");
    recordMobilePrivacyConsent();
  };
  return <form className="mobile-account-login" onSubmit={(event) => {
    event.preventDefault();
    props.run(async () => { accept(); props.onLogin(await loginIapAccount(phone, code)); setCode(""); });
  }}>
    <h2>手机号登录</h2>
    <p>使用在问平台的手机号。未注册的手机号登录后会创建账户。</p>
    <label className="mobile-entry-field">手机号（中国大陆）<input type="tel" autoComplete="tel-national" value={phone} disabled={props.busy}
      placeholder="11 位手机号，不含 +86" onChange={(event) => setPhone(event.target.value)} /></label>
    <button type="button" className="secondary" disabled={props.busy || !consent || cooldown > 0} onClick={() => props.run(async () => {
      accept(); await requestIapLoginCode(phone); setCooldown(60);
    })}>{cooldown ? `${cooldown} 秒后重新发送` : "发送验证码"}</button>
    <label className="mobile-entry-field">短信验证码<input inputMode="numeric" autoComplete="one-time-code" value={code} disabled={props.busy}
      onChange={(event) => setCode(event.target.value)} /></label>
    <label className="mobile-entry-remember"><input type="checkbox" checked={consent} disabled={props.busy}
      onChange={(event) => setConsent(event.target.checked)} />我已阅读并同意 <a href={MINIQ_PRIVACY_URL} target="_blank" rel="noreferrer">《miniQ 隐私政策》</a></label>
    <button type="submit" disabled={props.busy || !consent}>登录</button>
  </form>;
}
