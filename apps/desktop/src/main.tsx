import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ToastProvider } from "./components/ui/Toast";
// Bundled fonts (self-hosted, offline). Latin: Inter (UI) + JetBrains Mono
// (code); CJK: MiSans VF subset (@font-face lives in styles/base.css).
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/themes.css";
import "./styles/conversation.css";
import "./components/ConversationNavigationRail.css";
import "./styles/interactions.css";
import "./styles/review.css";
import "./styles/pages.css";
import "./styles/scheduling.css";
import "./styles/remote.css";
import "./styles/experience.css";
import "./styles/theme-picker.css";
import "./styles/living-background.css";
import "./external-sessions.css";
import "./styles/mobile-controls.css";
import "./styles/window-chrome.css";
import { initializeAppearance } from "./theme";
import { initializeBackground } from "./background";
import { initializeRotation } from "./backgroundRotation";
import { LivingBackground } from "./components/LivingBackground";
import { initializeMobileRuntime } from "./mobileRuntime";
import { initializeMobileViewport } from "./mobileViewport";
import { initializeWindowChrome } from "./windowChrome";
import { initializeNativeMenuBridge } from "./nativeMenuBridge";

initializeAppearance();
initializeBackground();
initializeRotation();
initializeWindowChrome();
initializeMobileViewport();
initializeNativeMenuBridge();
void initializeMobileRuntime();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <LivingBackground />
      <App />
    </ToastProvider>
  </React.StrictMode>,
);

// WebKit may defer requestAnimationFrame while a packaged window is opening.
// Observe React's root directly so the splash cannot cover a ready app.
function hideSplashWhenReady() {
  const splash = document.getElementById("splash");
  if (!splash) return;
  const root = document.getElementById("root");
  if (!root) return;

  let hidden = false;
  const hide = () => {
    if (hidden || root.childElementCount === 0) return;
    hidden = true;
    observer.disconnect();
    splash.classList.add("splash-hide");
    window.setTimeout(() => splash.remove(), 300);
  };
  const observer = new MutationObserver(hide);
  observer.observe(root, { childList: true });
  hide();
}
hideSplashWhenReady();
