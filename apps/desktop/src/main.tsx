import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Bundled fonts (self-hosted, offline). Latin: Inter (UI) + JetBrains Mono
// (code); CJK: MiSans VF subset (@font-face lives in styles.css).
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Fade out the inline splash (index.html) once React has painted its first
// frame into #root.
function hideSplash() {
  const splash = document.getElementById("splash");
  if (!splash) return;
  const root = document.getElementById("root");
  if (!root || root.childElementCount === 0) {
    requestAnimationFrame(hideSplash);
    return;
  }
  splash.classList.add("splash-hide");
  window.setTimeout(() => splash.remove(), 300);
}
requestAnimationFrame(hideSplash);
