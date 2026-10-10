import { useEffect, useState } from "react";
import { DEFAULT_COMPANION_PREFS, listenCompanionPrefs, readCompanionPrefs, setCompanionMode, type CompanionMode } from "../companionPrefs";
import { errorMessage } from "../errorMessage";
import { isTauriRuntime } from "../runtime";

export function CompanionSettings() {
  const [prefs, setPrefs] = useState(DEFAULT_COMPANION_PREFS);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    void readCompanionPrefs().then((value) => { if (!disposed) setPrefs(value); })
      .catch((cause) => { if (!disposed) setError(errorMessage(cause)); })
      .finally(() => { if (!disposed) setBusy(false); });
    void listenCompanionPrefs((value) => { if (!disposed) setPrefs(value); })
      .then((dispose) => { if (disposed) dispose(); else off = dispose; })
      .catch((cause) => { if (!disposed) setError(errorMessage(cause)); });
    return () => { disposed = true; off?.(); };
  }, []);
  if (typeof window === "undefined" || !isTauriRuntime()) return null;
  const change = async (mode: CompanionMode) => {
    setBusy(true); setError(null);
    try { setPrefs(await setCompanionMode(mode)); } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <section className="settings-section" aria-labelledby="companion-settings-title">
    <h3 id="companion-settings-title">桌面伙伴</h3>
    <p>可选的桌面任务入口。默认隐藏；与提醒音效独立，不会持续监听麦克风。</p>
    <label>外观 <select aria-label="桌面伙伴外观" value={prefs.mode} disabled={busy} onChange={(event) => void change(event.target.value as CompanionMode)}>
      <option value="hidden">隐藏（默认）</option><option value="dots">状态圆点</option><option value="pet">小伙伴</option>
    </select></label>
    {error && <p role="alert">{error}</p>}
  </section>;
}
