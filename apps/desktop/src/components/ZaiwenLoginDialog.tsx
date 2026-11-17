import { useEffect, useState } from "react";
import { loginZaiwen, requestZaiwenLoginCode, type ZaiwenSession } from "../zaiwenAuth";
import { Dialog } from "./ui/Dialog";
import { Button } from "./ui/Button";
import "./ZaiwenLoginDialog.css";

export function ZaiwenLoginDialog(props: { open: boolean; onClose: () => void; onLogin: (session: ZaiwenSession) => void }) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [consent, setConsent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!cooldown) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  useEffect(() => { if (!props.open) { setError(null); setCode(""); } }, [props.open]);
  const sendCode = async () => {
    if (busy || cooldown) return;
    if (!consent) { setError("请先阅读并同意在问服务协议和隐私条款"); return; }
    setBusy(true); setError(null);
    try { await requestZaiwenLoginCode(phone); setCooldown(60); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "验证码发送失败，请重试"); }
    finally { setBusy(false); }
  };
  const login = async () => {
    if (busy) return;
    if (!consent) { setError("请先阅读并同意在问服务协议和隐私条款"); return; }
    setBusy(true); setError(null);
    try { props.onLogin(await loginZaiwen(phone, code)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "登录失败，请检查验证码后重试"); }
    finally { setBusy(false); }
  };
  return <Dialog open={props.open} title="登录在问" description="登录后切换到在问会话，使用 miniQ 界面查看聊天记录。" onClose={props.onClose}
    footer={<><Button variant="secondary" onClick={props.onClose}>取消</Button><Button disabled={busy || !consent} onClick={() => void login()}>登录并切换</Button></>}>
    <div className="zaiwen-login-form">
      <label>手机号<input type="tel" autoComplete="tel-national" value={phone} disabled={busy} placeholder="11 位手机号" onChange={(event) => setPhone(event.target.value)} /></label>
      <label>短信验证码<div className="zaiwen-code-row"><input inputMode="numeric" autoComplete="one-time-code" value={code} disabled={busy} placeholder="4–6 位验证码" onChange={(event) => { setCode(event.target.value); setError(null); }} /><button type="button" disabled={busy || cooldown > 0} onClick={() => void sendCode()}>{cooldown ? `${cooldown} 秒后重发` : "获取验证码"}</button></div></label>
      <label className="zaiwen-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={(event) => setConsent(event.target.checked)} />我已阅读并同意在问服务协议和隐私条款</label>
      {error && <p role="alert">{error}</p>}
    </div>
  </Dialog>;
}
