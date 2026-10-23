import type { CapacitorConfig } from "@capacitor/cli";

/**
 * 手机端热更新开关：设置 CAP_DEV_SERVER_URL 后，WebView 直接连开发服务器，
 * 改前端代码立刻生效。
 *
 * 注意：地址必须是「安全上下文」，否则 WebCrypto（crypto.subtle）不可用，
 * 配对与 Key 加密保存都会失败。WebView 只把 https 和 localhost 当作安全上下文，
 * 所以模拟器/真机请用 http://localhost:1420 配合 `adb reverse tcp:1420 tcp:1420`，
 * 不要用 http://10.0.2.2:1420 或局域网 IP。
 *
 * 不设置该变量时保持打包资源，`cap sync` 会把它写回原生工程的 capacitor.config.json。
 */
const devServerUrl = process.env.CAP_DEV_SERVER_URL?.trim();

const config: CapacitorConfig = {
  appId: "com.leadingthink.miniq",
  appName: "miniQ",
  webDir: "dist",
  backgroundColor: "#f2f2f5",
  loggingBehavior: "none",
  server: {
    hostname: "localhost",
    androidScheme: "https",
    iosScheme: "capacitor",
    ...(devServerUrl ? { url: devServerUrl, cleartext: true } : {}),
  },
  android: {
    // @capacitor/push-notifications is iOS-only here (APNs). On Android it
    // would pull in Firebase Messaging, whose transitive deps ship ABI-specific
    // .so files that break the universal WebView APK check; Android push goes
    // through the native MiniqPush/MiniqBackground plugins instead.
    includePlugins: [
      "@capacitor/app",
      "@capacitor/network",
      "@capacitor/device",
      "@capacitor/haptics",
      "@capacitor/keyboard",
      "@capacitor/local-notifications",
      "@capacitor/status-bar",
      "capacitor-secure-storage-plugin",
    ],
  },
  plugins: {
    App: {
      disableBackButtonHandler: true,
    },
    Keyboard: {
      resize: "native",
      resizeOnFullScreen: true,
    },
    StatusBar: {
      overlaysWebView: false,
      style: "LIGHT",
      backgroundColor: "#f2f2f5",
    },
  },
};

export default config;
