import { Capacitor } from "@capacitor/core";
import { iosInstalledReleaseNotices } from "../iosInstalledReleaseNotice";
import { mobileUpdateScheduler } from "../mobileUpdateScheduler";
import { Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage } from "../errorMessage";
import { openMobileUpdateUrl } from "../mobileUpdateLinks";
import {
  formatFileSize,
  IOS_APP_STORE_URL,
  isOfficialIosAppStoreUrl,
  isOfficialAndroidApk,
  isMobileUpdateSupported,
  MOBILE_DOWNLOAD_PAGE_URL,
  readInstalledVersion,
  type MobileUpdateState,
} from "../mobileUpdate";

/** Settings entry for native Android and iOS updates. */
export function MobileUpdateCheck() {
  const ios = Capacitor.getPlatform() === "ios";
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
      const result = await mobileUpdateScheduler.run(true);
      if (result.phase === "available") iosInstalledReleaseNotices.cache(result.release);
      setState(result);
    } catch (error) {
      setState({ phase: "error", error: errorMessage(error) });
    }
  };

  const download = async (url: string) => {
    try {
      if (ios ? !isOfficialIosAppStoreUrl(url) : url !== MOBILE_DOWNLOAD_PAGE_URL && !isOfficialAndroidApk(url)) throw new Error("下载地址无效");
      await openMobileUpdateUrl(url);
    } catch { setState({ phase: "error", error: "无法打开下载链接，请稍后重试。" }); }
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
      {state.phase === "error" && (
        <div>
          <p role="alert">检查更新失败：{state.error}</p>
          <button type="button" className="secondary" onClick={() => void download(ios ? IOS_APP_STORE_URL : MOBILE_DOWNLOAD_PAGE_URL)}>
            <Download size={14} />
            {ios ? "前往 App Store" : "前往下载页"}
          </button>
        </div>
      )}
      {release && (
        <div className="mobile-update-available">
          <p role="status">
            发现新版本 {release.version}
            {size ? `（${size}）` : ""}
          </p>
          {release.releaseNotes && release.releaseNotes.length > 0 && <ul>{release.releaseNotes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
          {release.installationNotes.length > 0 && (
            <ul>
              {release.installationNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => void download(release.url)}>
            <Download size={14} />
            {ios ? "前往 App Store" : "在浏览器中下载"}
          </button>
        </div>
      )}
    </section>
  );
}
