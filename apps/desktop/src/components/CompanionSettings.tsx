import { MousePointerClick } from "lucide-react";
import { useEffect, useState } from "react";
import { DEFAULT_COMPANION_PREFS, listenCompanionPrefs, readCompanionPrefs, setCompanionMode, type CompanionMode } from "../companionPrefs";
import { errorMessage } from "../errorMessage";
import { isNativeMobileApp } from "../mobileRuntime";
import { isTauriRuntime } from "../runtime";
import "./NotificationSettings.css";

const MODES: { mode: CompanionMode; label: string }[] = [
  { mode: "hidden", label: "隐藏" },
  { mode: "dots", label: "圆点" },
  { mode: "pet", label: "小伙伴" },
];

export function CompanionSettings() {
  const desktop = typeof window !== "undefined" && isTauriRuntime();
  const [prefs, setPrefs] = useState(DEFAULT_COMPANION_PREFS);
  const [busy, setBusy] = useState(desktop);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let off: (() => void) | undefined;
    void readCompanionPrefs().then((value) => { if (!disposed) setPrefs(value); })
      .catch((cause) => { if (!disposed) setError(errorMessage(cause)); })
      .finally(() => { if (!disposed) setBusy(false); });
    void listenCompanionPrefs((value) => { if (!disposed) setPrefs(value); })
      .then((dispose) => { if (disposed) dispose(); else off = dispose; })
      .catch((cause) => { if (!disposed) setError(errorMessage(cause)); });
    return () => { disposed = true; off?.(); };
  }, [desktop]);
  if (typeof window === "undefined" || isNativeMobileApp()) return null;
  const change = async (mode: CompanionMode) => {
    if (busy || mode === prefs.mode) return;
    setBusy(true); setError(null);
    try { setPrefs(await setCompanionMode(mode)); } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <section className="settings-section" aria-label="桌面伙伴">
    <div>
      <div className="settings-section-title"><MousePointerClick size={15} /><span>桌面伙伴</span></div>
      <p className="settings-section-description">在桌面上显示一个可点击的快速入口，点击后输入任务</p>
    </div>
    {desktop ? <div className="settings-card">
      <div className="settings-toggle-row">
        <span className="settings-row-label">显示方式</span>
        <div className="settings-segmented" role="group" aria-label="桌面伙伴外观" aria-busy={busy}>
          {MODES.map(({ mode, label }) => (
            <button key={mode} type="button" aria-pressed={prefs.mode === mode} disabled={busy} onClick={() => void change(mode)}>{label}</button>
          ))}
        </div>
      </div>
    </div> : <p className="settings-section-description" role="note">仅桌面客户端可用</p>}
    {error && <p className="settings-error" role="alert">{error}</p>}
  </section>;
}
