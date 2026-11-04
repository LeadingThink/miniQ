import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("ships the shared frontend through the Tauri and Capacitor WebView entry points", () => {
  const tauri = JSON.parse(
    readFileSync(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  expect(tauri.build.frontendDist).toBe("../dist");
  const tauriLock = readFileSync(
    new URL("../src-tauri/Cargo.lock", import.meta.url),
    "utf8",
  );
  expect(tauriLock).toContain('name = "tauri-runtime-wry"');
  const tauriEntry = readFileSync(
    new URL("../src-tauri/src/lib.rs", import.meta.url),
    "utf8",
  );
  expect(tauriEntry).toContain("current_data_directory");
  expect(tauriEntry).toContain("choose_data_directory");

  const capacitor = readFileSync(
    new URL("../capacitor.config.ts", import.meta.url),
    "utf8",
  );
  expect(capacitor).toMatch(/webDir:\s*["']dist["']/);
  expect(capacitor).not.toContain("choose_data_directory");

  const openPreviewButton = readFileSync(
    new URL("./components/OpenPreviewButton.tsx", import.meta.url),
    "utf8",
  );
  expect(openPreviewButton).toContain('import("@tauri-apps/plugin-dialog")');
  expect(openPreviewButton).toContain("setPath(selected)");
  expect(openPreviewButton).toMatch(/!remote\s*&&\s*<button/);
  const appStatusCss = readFileSync(
    new URL("./components/AppStatus.css", import.meta.url),
    "utf8",
  );
  expect(appStatusCss).toMatch(
    /\.open-preview-path-control:focus-within\s*\{[^}]*border-color:\s*var\(--focus-ring, var\(--accent\)\);/,
  );
  expect(appStatusCss).toMatch(
    /\.open-preview-dialog input\s*\{[^}]*border:\s*0;[^}]*outline:\s*none;/,
  );

  const androidEntry = readFileSync(
    new URL(
      "../android/app/src/main/java/com/leadingthink/miniq/MainActivity.java",
      import.meta.url,
    ),
    "utf8",
  );
  expect(androidEntry).toContain("extends BridgeActivity");
  const androidLayout = readFileSync(
    new URL("../android/app/src/main/res/layout/activity_main.xml", import.meta.url),
    "utf8",
  );
  expect(androidLayout).toContain("<WebView");

  const iosPackage = readFileSync(
    new URL("../ios/App/CapApp-SPM/Package.swift", import.meta.url),
    "utf8",
  );
  expect(iosPackage).toContain("capacitor-swift-pm");

  const iosEntry = readFileSync(
    new URL("../ios/App/App/MainViewController.swift", import.meta.url),
    "utf8",
  );
  expect(iosEntry).toContain("CAPBridgeViewController");
  const iosScene = readFileSync(
    new URL("../ios/App/App/SceneDelegate.swift", import.meta.url),
    "utf8",
  );
  expect(iosScene).toContain("rootViewController = MainViewController()");

  const webEntry = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
  expect(webEntry).toContain('import "./styles/base.css"');

  const baseCss = readFileSync(new URL("./styles/base.css", import.meta.url), "utf8");
  expect(baseCss).toContain('@import "./conversation-v2.css"');
  const conversationCss = readFileSync(
    new URL("./styles/conversation.css", import.meta.url),
    "utf8",
  );
  expect(conversationCss).toMatch(
    /\.composer-field\.has-paste > textarea\.is-before-paste\s*\{[^}]*flex:\s*0 1 auto;/,
  );
  const sideConversationCss = readFileSync(
    new URL("./components/SideConversationPanel.css", import.meta.url),
    "utf8",
  );
  expect(sideConversationCss).toMatch(
    /\.side-conversation\s*\{[^}]*border-left:\s*1px solid var\(--hairline\);[^}]*background:\s*var\(--bg\);/,
  );
  expect(sideConversationCss).toMatch(/\.side-conversation > \.workbench-resizer::before\s*\{\s*display:\s*none;/);
  expect(sideConversationCss).toMatch(
    /@media \(max-width: 820px\)[\s\S]*\.side-conversation > \.workbench-resizer\s*\{\s*display:\s*none;/,
  );
  const workbenchResizer = readFileSync(
    new URL("./components/WorkbenchResizer.tsx", import.meta.url),
    "utf8",
  );
  expect(workbenchResizer).toContain('import "./WorkbenchResizer.css"');

  const timeline = readFileSync(
    new URL("./components/Timeline.tsx", import.meta.url),
    "utf8",
  );
  expect(timeline).toContain("<AgentStatusIndicator");

  const timelineInteractions = readFileSync(
    new URL("./components/TimelineInteractions.tsx", import.meta.url),
    "utf8",
  );
  expect(timelineInteractions).toContain('import "./ArtifactCard.css"');
  const artifactCardCss = readFileSync(
    new URL("./components/ArtifactCard.css", import.meta.url),
    "utf8",
  );
  expect(artifactCardCss).toMatch(
    /\.artifact-file\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/,
  );

  const hero = readFileSync(
    new URL("./components/HeroPage.tsx", import.meta.url),
    "utf8",
  );
  const shell = readFileSync(
    new URL("./components/AppShell.tsx", import.meta.url),
    "utf8",
  );
  expect(hero).toContain("<SessionModelControls");
  expect(shell).toContain("<SessionModelControls");
  const modelControls = readFileSync(
    new URL("./components/SessionModelControls.tsx", import.meta.url),
    "utf8",
  );
  expect(modelControls).toContain('call<ModelPerformanceResult>("model.performance")');
  expect(modelControls).toContain("<ModelPerformanceIndicator");
  expect(modelControls).toContain('className="model-picker-hover-target"');
  expect(modelControls).toContain("onMouseLeave={scheduleClose}");
  const performanceIndicator = readFileSync(
    new URL("./components/ModelPerformanceIndicator.tsx", import.meta.url),
    "utf8",
  );
  expect(performanceIndicator).toContain("可用性");
  expect(performanceIndicator).not.toContain("吞吐");
  expect(performanceIndicator).not.toContain("model-performance-chart");

  const modelSurface = readFileSync(
    new URL("./components/SessionModelSurface.tsx", import.meta.url),
    "utf8",
  );
  expect(modelSurface).toContain('import "./SessionModelSurface.css"');
  const modelSurfaceCss = readFileSync(
    new URL("./components/SessionModelSurface.css", import.meta.url),
    "utf8",
  );
  expect(modelSurfaceCss).toMatch(
    /\.session-model-dialog \.session-model-popover \.model-picker-row > button\s*\{[^}]*display:\s*flex;/,
  );
  expect(modelSurfaceCss).toMatch(
    /\.session-model-dialog \.session-model-popover \.model-picker-hover-target\s*\{[^}]*display:\s*flex;/,
  );
  expect(modelSurfaceCss).toMatch(
    /\.session-model-dialog \.session-model-popover \.model-performance\s*\{[^}]*flex:\s*1 1 100%;[^}]*border-left:\s*0;/,
  );
});
