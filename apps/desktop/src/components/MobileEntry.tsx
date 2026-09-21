import { ArrowLeft, Bot, ExternalLink, Laptop, LifeBuoy, ShieldCheck, Wifi } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { isNativeMobileApp } from "../mobileRuntime";
import { isRememberEnabled, loadRemoteCredentials, readRemoteCredentials, setRememberEnabled, storeRemoteCredentials } from "../remoteAccess";
import { MobileUpdateCheck } from "./MobileUpdateCheck";
import { clearMobilePrivacyConsent, hasMobilePrivacyConsent, MINIQ_PRIVACY_URL, MINIQ_SUPPORT_URL, recordMobilePrivacyConsent } from "../mobilePrivacy";
import { MobileKeyField } from "./MobileKeyField";
import "./MobileEntry.css";

const MobileChat = lazy(() => import("./MobileChat").then((module) => ({ default: module.MobileChat })));

export function MobileEntry(props: { onRemote: () => void }) {
  const saved = readRemoteCredentials();
  const [section, setSection] = useState<"home" | "chat" | "remote">("home");
  const [apiKey, setApiKey] = useState(saved?.apiKey ?? "");
  const [deviceName, setDeviceName] = useState(saved?.deviceName ?? defaultDeviceName());
  const [error, setError] = useState<string | null>(null);
  const [remember, setRemember] = useState(() => isRememberEnabled());
  const [loadingCredentials, setLoadingCredentials] = useState(isNativeMobileApp());
  const [privacyAccepted, setPrivacyAccepted] = useState(hasMobilePrivacyConsent);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);
  const keyInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isNativeMobileApp()) return;
    let active = true;
    void loadRemoteCredentials()
      .then((credentials) => {
        if (!active || !credentials) return;
        setApiKey(credentials.apiKey);
        setDeviceName(credentials.deviceName);
      })
      .catch(() => { if (active) setError("暂时无法读取已保存的 Key，你可以重新输入后继续。"); })
      .finally(() => { if (active) setLoadingCredentials(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!isNativeMobileApp()) return;
    let disposed = false;
    let listener: { remove: () => Promise<void> } | undefined;
    void import("@capacitor/app").then(async ({ App }) => {
      if (disposed) return;
      const handle = await App.addListener("backButton", () => {
        if (saving.current) return;
        if (section !== "home") {
          setError(null);
          setSection("home");
        } else {
          void App.minimizeApp();
        }
      });
      if (disposed) void handle.remove();
      else listener = handle;
    }).catch(() => {});
    return () => {
      disposed = true;
      void listener?.remove();
    };
  }, [section]);

  const persist = async () => {
    const key = apiKey.trim();
    if (!key) {
      setError("请输入在问 API Key");
      keyInput.current?.focus();
      return false;
    }
    if (!privacyAccepted) {
      setError("请先阅读并同意《miniQ 隐私政策》");
      return false;
    }
    try {
      recordMobilePrivacyConsent();
      await storeRemoteCredentials(
        { apiKey: key, deviceName: deviceName.trim() || defaultDeviceName() },
        { remember },
      );
      setError(null);
      return true;
    } catch {
      setError("无法安全保存 Key，请稍后重试。你的 Key 不会显示在错误信息中。");
      return false;
    }
  };

  const proceed = async (destination: "chat" | "remote") => {
    if (saving.current || loadingCredentials) return;
    saving.current = true;
    setPending(true);
    try {
      if (!await persist()) return;
      if (destination === "chat") setSection("chat");
      else props.onRemote();
    } finally {
      saving.current = false;
      setPending(false);
    }
  };

  if (section === "chat") {
    return <Suspense fallback={<main className="mobile-entry">
      <p role="status">正在加载移动问答…</p>
      <button type="button" onClick={() => setSection("home")}><ArrowLeft size={15} />返回</button>
    </main>}><MobileChat apiKey={apiKey.trim()} onBack={() => setSection("home")} /></Suspense>;
  }

  return (
    <main className="mobile-entry">
      <div className="mobile-entry-brand"><span>miniQ</span><small>移动工作台</small></div>
      <form className="mobile-entry-sheet" aria-busy={pending || loadingCredentials} onSubmit={(event) => {
        event.preventDefault();
        void proceed(section === "remote" ? "remote" : "chat");
      }}>
        <div className="mobile-entry-heading">
          <h1>{section === "remote" ? "连接桌面 miniQ" : "随时继续工作"}</h1>
          <p>{section === "remote" ? "桌面端开启远程访问后，使用同一个 Key 安全连接。" : "移动问答独立运行；远程桌面可以继续项目任务、查看进度并处理审批。"}</p>
        </div>

        <MobileKeyField inputRef={keyInput} value={apiKey} disabled={loadingCredentials || pending} native={isNativeMobileApp()}
          onChange={(value) => { setApiKey(value); setError(null); }} />
        {loadingCredentials && <p className="mobile-entry-progress" role="status">正在读取这台设备保存的 Key…</p>}
        {pending && <p className="mobile-entry-progress" role="status">正在安全保存连接设置…</p>}

        {!isNativeMobileApp() && (
          <label className="mobile-entry-remember">
            <input
              type="checkbox"
              checked={remember}
              disabled={pending || loadingCredentials}
              onChange={(event) => {
                setRemember(event.target.checked);
                setRememberEnabled(event.target.checked);
              }}
            />
            <span>在这台设备上记住 Key（下次打开无需重新输入）</span>
          </label>
        )}

        <div className="mobile-entry-consent">
          <input
            id="mobile-privacy-consent"
            type="checkbox"
            checked={privacyAccepted}
            disabled={pending || loadingCredentials}
            onChange={(event) => {
              setPrivacyAccepted(event.target.checked);
              if (!event.target.checked) clearMobilePrivacyConsent();
              setError(null);
            }}
          />
          <label htmlFor="mobile-privacy-consent">我已阅读并同意</label>
          <a href={MINIQ_PRIVACY_URL} target="_blank" rel="noreferrer">《miniQ 隐私政策》<ExternalLink size={12} /></a>
        </div>

        {section === "remote" && (
          <label className="mobile-entry-field">
            <span>这台设备的名称</span>
            <input value={deviceName} maxLength={80} disabled={pending || loadingCredentials} onChange={(event) => setDeviceName(event.target.value)} />
          </label>
        )}
        {error && <div className="mobile-entry-error" role="alert">{error}</div>}

        {section === "home" ? (
          <div className="mobile-entry-actions">
            <button type="button" className="mobile-mode-card primary" disabled={pending || loadingCredentials || !privacyAccepted} onClick={() => { void proceed("chat"); }}>
              <span className="mobile-mode-icon"><Bot size={21} /></span>
              <span><strong>移动问答</strong><small>桌面不在线也能使用，支持流式回答和历史保留</small></span>
            </button>
            <button type="button" className="mobile-mode-card" disabled={pending || loadingCredentials} onClick={() => { setError(null); setSection("remote"); }}>
              <span className="mobile-mode-icon"><Laptop size={21} /></span>
              <span><strong>远程桌面</strong><small>同步桌面项目、任务进度、会话与待审批操作</small></span>
            </button>
          </div>
        ) : (
          <div className="mobile-entry-footer">
            <button type="button" className="secondary" disabled={pending} onClick={() => { setError(null); setSection("home"); }}><ArrowLeft size={15} />返回</button>
              <button type="submit" disabled={pending || loadingCredentials || !privacyAccepted}><Wifi size={15} />{pending ? "正在准备连接…" : "连接桌面端"}</button>
            </div>
        )}
        {section === "remote" && <details className="mobile-entry-help">
          <summary>电脑没有出现，或一直连接中？</summary>
          <ol><li>确认电脑上的 miniQ 已打开，并已开启“设置 → 服务与远程 → 允许远程连接”。</li><li>手机和电脑使用同一个在问 API Key，电脑保持联网且未休眠。</li><li>已在桌面保存的 SSH 电脑，连接后可在项目侧栏切换。</li></ol>
          <p>手机断线不会停止电脑上正在执行的任务；恢复连接后会同步进度。</p>
        </details>}
      </form>
      <MobileUpdateCheck />
      <div className="mobile-entry-links">
        <a href={MINIQ_PRIVACY_URL} target="_blank" rel="noreferrer"><ShieldCheck size={13} />隐私政策</a>
        <a href={MINIQ_SUPPORT_URL} target="_blank" rel="noreferrer"><LifeBuoy size={13} />技术支持</a>
      </div>
      <p className="mobile-entry-security">API Key 与 AI 请求通过 HTTPS 加密传输，并由所选模型服务处理。远程桌面内容另使用 AES-256-GCM 端到端加密，relay 只转发密文。</p>
    </main>
  );
}

function defaultDeviceName(): string {
  const platform = navigator.userAgent.includes("iPhone") ? "iPhone" : navigator.userAgent.includes("Android") ? "Android 手机" : "移动浏览器";
  return `miniQ ${platform}`;
}
