import type { CapacitorConfig } from "@capacitor/cli";

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
