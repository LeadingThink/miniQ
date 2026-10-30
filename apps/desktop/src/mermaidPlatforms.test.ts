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

  const androidEntry = readFileSync(
    new URL(
      "../android/app/src/main/java/com/leadingthink/miniq/MainActivity.java",
      import.meta.url,
    ),
    "utf8",
  );
  expect(androidEntry).toContain("extends BridgeActivity");

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

  const webEntry = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");
  expect(webEntry).toContain('import "./styles/base.css"');

  const baseCss = readFileSync(new URL("./styles/base.css", import.meta.url), "utf8");
  expect(baseCss).toContain('@import "./conversation-v2.css"');

  const timeline = readFileSync(
    new URL("./components/Timeline.tsx", import.meta.url),
    "utf8",
  );
  expect(timeline).toContain("<AgentStatusIndicator");

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
});
