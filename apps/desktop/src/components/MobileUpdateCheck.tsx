import { Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage } from "../errorMessage";
import { openExternalUrl } from "../externalLinks";
import {
  checkAndroidUpdate,
  formatFileSize,
  isMobileUpdateSupported,
  readInstalledVersion,
  type MobileUpdateState,
} from "../mobileUpdate";

/** Android APKs are distributed outside an app store, so the client offers an
 * explicit "check for updates" action and hands the APK url to the system
 * browser — no install permission is requested. */
export function MobileUpdateCheck() {
  const [supported] = useState(() => isMobileUpdateSupported());
  const [installed, setInstalled] = useState<string | null>(null);
  const [state, setState] = useState<MobileUpdateState>({ phase: "idle" });

  useEffect(() => {
    if (!supported) return;
    let disposed = false;
    void readInstalledVersion().then((version) => {
      if (!disposed) setInstalled(version);
    });
    return () => {
      disposed = true;
    };
  }, [supported]);

  if (!supported) return null;

  const check = async () => {
    if (state.phase === "checking") return;
    setState({ phase: "checking" });
    try {
      setState(await checkAndroidUpdate({ currentVersion: installed ?? undefined }));
    } catch (error) {
      setState({ phase: "error", error: errorMessage(error) });
    }
  };

  const release = state.phase === "available" ? state.release : null;
  const size = formatFileSize(release?.fileSize);

  return (
    <section className="mobile-update">
      <div className="mobile-update-row">
        <span className="mobile-update-version">当前版本 {installed ?? "未知"}</span>
        <button type="button" className="secondary" disabled={state.phase === "checking"} onClick={() => void check()}>
          <RefreshCw size={14} />
          {state.phase === "checking" ? "检查中…" : "检查更新"}
        </button>
      </div>
      {state.phase === "unavailable" && <p role="status">已是最新版本</p>}
      {state.phase === "error" && <p role="alert">检查更新失败：{state.error}</p>}
      {release && (
        <div className="mobile-update-available">
          <p role="status">
            发现新版本 {release.version}
            {size ? `（${size}）` : ""}
          </p>
          {release.installationNotes.length > 0 && (
            <ul>
              {release.installationNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => void openExternalUrl(release.url)}>
            <Download size={14} />
            在浏览器中下载
          </button>
        </div>
      )}
    </section>
  );
}
