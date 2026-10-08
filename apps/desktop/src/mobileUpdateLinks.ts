import { isMobileUpdateSupported, isOfficialAndroidApk, isOfficialIosAppStoreUrl, MOBILE_DOWNLOAD_PAGE_URL } from "./mobileUpdate";
import { openExternalUrl } from "./externalLinks";

/** Capacitor's BridgeWebViewClient intercepts external navigation with ACTION_VIEW.
 * Using the current window avoids depending on WebView popup support. Keep the
 * official download host outside capacitor.config.server.allowNavigation.
 */
// Capacitor iOS WebViewDelegationHandler opens non-app main-frame URLs through
// UIApplication.shared.open. apps.apple.com must remain outside allowNavigation.
export async function openMobileUpdateUrl(url: string): Promise<void> {
  if (url !== MOBILE_DOWNLOAD_PAGE_URL && !isOfficialAndroidApk(url) && !isOfficialIosAppStoreUrl(url)) throw new Error("下载地址无效");
  if (isMobileUpdateSupported()) {
    window.location.assign(url);
    return;
  }
  await openExternalUrl(url);
}
