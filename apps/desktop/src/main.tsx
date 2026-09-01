import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Bundled fonts (self-hosted, offline). Latin: Inter (UI) + JetBrains Mono
// (code); CJK: MiSans VF subset (@font-face lives in styles/base.css).
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./styles/base.css";
import "./styles/themes.css";
import "./styles/conversation.css";
import "./styles/interactions.css";
import "./styles/review.css";
import "./styles/pages.css";
import "./styles/scheduling.css";
import "./external-sessions.css";
import { applyTheme, readStoredTheme } from "./theme";

applyTheme(readStoredTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
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
