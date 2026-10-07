import { isMobileUpdateSupported, isOfficialAndroidApk, MOBILE_DOWNLOAD_PAGE_URL } from "./mobileUpdate";
import { openExternalUrl } from "./externalLinks";

/** Capacitor's BridgeWebViewClient intercepts external navigation with ACTION_VIEW.
 * Using the current window avoids depending on WebView popup support. Keep the
 * official download host outside capacitor.config.server.allowNavigation.
 */
export async function openMobileUpdateUrl(url: string): Promise<void> {
  if (url !== MOBILE_DOWNLOAD_PAGE_URL && !isOfficialAndroidApk(url)) throw new Error("下载地址无效");
  if (isMobileUpdateSupported()) {
    window.location.assign(url);
    return;
  }
  await openExternalUrl(url);
}
